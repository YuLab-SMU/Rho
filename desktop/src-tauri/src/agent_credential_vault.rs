use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use anyhow::{Context, Result, ensure};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;
use zeroize::{Zeroize, Zeroizing};

pub(crate) const VAULT_FILE_NAME: &str = "agent-local-credentials.json";
const LOCAL_KEY_FILE_NAME: &str = "agent-local-credentials.key";
const LOCAL_SECRET_BYTES: usize = 32;
const VAULT_SCHEMA_VERSION: u32 = 1;
const KDF_ALGORITHM: &str = "argon2id";
const KDF_MEMORY_KIB: u32 = 65_536;
const KDF_PASSES: u32 = 3;
const KDF_LANES: u32 = 1;
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
const KEY_BYTES: usize = 32;
const MAX_VAULT_BYTES: u64 = 256 * 1024;
const MAX_ENTRY_COUNT: usize = 256;
const MAX_PROVIDER_ID_BYTES: usize = 120;
const MAX_CREDENTIAL_BYTES: usize = 4_096;
const MIN_PASSWORD_BYTES: usize = 12;
const MAX_PASSWORD_BYTES: usize = 1_024;

static VAULT_SESSIONS: OnceLock<Mutex<HashMap<PathBuf, Zeroizing<[u8; KEY_BYTES]>>>> =
    OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CredentialVaultStatus {
    Missing,
    Saved,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct VaultKdfHeader {
    algorithm: String,
    memory_kib: u32,
    passes: u32,
    lanes: u32,
}

impl Default for VaultKdfHeader {
    fn default() -> Self {
        Self {
            algorithm: KDF_ALGORITHM.to_string(),
            memory_kib: KDF_MEMORY_KIB,
            passes: KDF_PASSES,
            lanes: KDF_LANES,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialVaultFile {
    schema_version: u32,
    kdf: VaultKdfHeader,
    salt: String,
    nonce: String,
    entry_ids: Vec<String>,
    ciphertext: String,
}

#[derive(Serialize)]
struct CredentialVaultAad<'a> {
    schema_version: u32,
    kdf: &'a VaultKdfHeader,
    salt: &'a str,
    nonce: &'a str,
    entry_ids: &'a [String],
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialVaultPayload {
    entries: BTreeMap<String, String>,
}

impl Drop for CredentialVaultPayload {
    fn drop(&mut self) {
        for credential in self.entries.values_mut() {
            credential.zeroize();
        }
    }
}

fn sessions() -> &'static Mutex<HashMap<PathBuf, Zeroizing<[u8; KEY_BYTES]>>> {
    VAULT_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_guard() -> MutexGuard<'static, HashMap<PathBuf, Zeroizing<[u8; KEY_BYTES]>>> {
    sessions()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn normalized_data_dir(data_dir: &Path) -> PathBuf {
    data_dir.to_path_buf()
}

fn vault_path(data_dir: &Path) -> PathBuf {
    data_dir.join(VAULT_FILE_NAME)
}

fn local_key_path(data_dir: &Path) -> PathBuf {
    data_dir.join(LOCAL_KEY_FILE_NAME)
}

fn read_local_password(path: &Path) -> Result<Zeroizing<String>> {
    let metadata = fs::metadata(path).context("Rho could not access its local credential key.")?;
    ensure!(
        metadata.len() <= 128,
        "Rho's local credential key is invalid."
    );
    private_permissions(&OpenOptions::new().read(true).open(path)?)?;
    let password = Zeroizing::new(
        fs::read_to_string(path).context("Rho could not read its local credential key.")?,
    );
    validate_password(&password)?;
    Ok(password)
}

fn local_password(data_dir: &Path) -> Result<Zeroizing<String>> {
    let path = local_key_path(data_dir);
    if path.exists() {
        return read_local_password(&path);
    }

    let parent = path
        .parent()
        .context("The local credential key path has no parent directory.")?;
    fs::create_dir_all(parent).context("Rho could not create its credential directory.")?;
    let password = Zeroizing::new(BASE64.encode(rand::random::<[u8; LOCAL_SECRET_BYTES]>()));
    let mut temporary = NamedTempFile::new_in(parent)
        .context("Rho could not create its local credential key temporary file.")?;
    private_permissions(temporary.as_file())?;
    temporary
        .write_all(password.as_bytes())
        .context("Rho could not write its local credential key.")?;
    temporary
        .as_file()
        .sync_all()
        .context("Rho could not durably write its local credential key.")?;
    match temporary.persist_noclobber(&path) {
        Ok(file) => {
            private_permissions(&file)?;
            sync_parent(&path)?;
            Ok(password)
        }
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_local_password(&path)
        }
        Err(error) => Err(anyhow::anyhow!(error.error)
            .context("Rho could not initialize its local credential key.")),
    }
}

fn validate_password(password: &str) -> Result<()> {
    let length = password.len();
    ensure!(
        (MIN_PASSWORD_BYTES..=MAX_PASSWORD_BYTES).contains(&length),
        "The Rho Vault password must be between {MIN_PASSWORD_BYTES} and {MAX_PASSWORD_BYTES} bytes."
    );
    ensure!(
        !password.chars().any(char::is_control),
        "The Rho Vault password cannot contain control characters."
    );
    Ok(())
}

fn validate_provider_id(provider_id: &str) -> Result<()> {
    ensure!(!provider_id.is_empty(), "Provider ID cannot be empty.");
    ensure!(
        provider_id.len() <= MAX_PROVIDER_ID_BYTES,
        "Provider ID exceeds the vault limit."
    );
    ensure!(
        !provider_id.chars().any(char::is_control),
        "Provider ID contains control characters."
    );
    Ok(())
}

fn validate_credential(credential: &str) -> Result<()> {
    ensure!(!credential.is_empty(), "API key cannot be empty.");
    ensure!(
        credential.len() <= MAX_CREDENTIAL_BYTES,
        "API key exceeds the 4096-byte limit."
    );
    ensure!(
        !credential.chars().any(char::is_control),
        "API key cannot contain control characters."
    );
    Ok(())
}

fn decode_exact(label: &str, value: &str, expected: usize) -> Result<Vec<u8>> {
    let decoded = BASE64
        .decode(value)
        .with_context(|| format!("The Rho Vault {label} is invalid."))?;
    ensure!(
        decoded.len() == expected,
        "The Rho Vault {label} has an invalid length."
    );
    Ok(decoded)
}

fn validate_header(file: &CredentialVaultFile) -> Result<()> {
    ensure!(
        file.schema_version == VAULT_SCHEMA_VERSION,
        "The Rho Vault version is not supported."
    );
    ensure!(
        file.kdf == VaultKdfHeader::default(),
        "The Rho Vault key-derivation settings are not supported."
    );
    decode_exact("salt", &file.salt, SALT_BYTES)?;
    decode_exact("nonce", &file.nonce, NONCE_BYTES)?;
    ensure!(
        file.entry_ids.len() <= MAX_ENTRY_COUNT,
        "The Rho Vault contains too many entries."
    );
    let mut previous: Option<&str> = None;
    let mut unique = HashSet::with_capacity(file.entry_ids.len());
    for provider_id in &file.entry_ids {
        validate_provider_id(provider_id)?;
        ensure!(
            previous.is_none_or(|value| value < provider_id.as_str()),
            "The Rho Vault entry index is not canonical."
        );
        ensure!(
            unique.insert(provider_id.as_str()),
            "The Rho Vault entry index contains duplicates."
        );
        previous = Some(provider_id);
    }
    let ciphertext = BASE64
        .decode(&file.ciphertext)
        .context("The Rho Vault ciphertext is invalid.")?;
    ensure!(
        ciphertext.len() <= MAX_VAULT_BYTES as usize,
        "The Rho Vault ciphertext exceeds the size limit."
    );
    Ok(())
}

fn read_vault_file(data_dir: &Path) -> Result<CredentialVaultFile> {
    let path = vault_path(data_dir);
    let metadata = fs::metadata(&path).context("Rho could not access the credential vault.")?;
    ensure!(
        metadata.len() <= MAX_VAULT_BYTES,
        "The Rho Vault exceeds the size limit."
    );
    let bytes = fs::read(&path).context("Rho could not read the credential vault.")?;
    let file: CredentialVaultFile =
        serde_json::from_slice(&bytes).context("The Rho Vault file is invalid.")?;
    validate_header(&file)?;
    Ok(file)
}

fn params(header: &VaultKdfHeader) -> Result<Params> {
    Params::new(
        header.memory_kib,
        header.passes,
        header.lanes,
        Some(KEY_BYTES),
    )
    .context("Rho could not configure the credential vault.")
}

fn derive_key(
    password: &str,
    salt: &[u8],
    header: &VaultKdfHeader,
) -> Result<Zeroizing<[u8; KEY_BYTES]>> {
    let mut key = Zeroizing::new([0_u8; KEY_BYTES]);
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params(header)?);
    argon2
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|_| anyhow::anyhow!("Rho could not derive the credential vault key."))?;
    Ok(key)
}

fn aad(file: &CredentialVaultFile) -> Result<Vec<u8>> {
    serde_json::to_vec(&CredentialVaultAad {
        schema_version: file.schema_version,
        kdf: &file.kdf,
        salt: &file.salt,
        nonce: &file.nonce,
        entry_ids: &file.entry_ids,
    })
    .context("Rho could not authenticate the credential vault header.")
}

fn decrypt_payload(
    file: &CredentialVaultFile,
    key: &[u8; KEY_BYTES],
) -> Result<CredentialVaultPayload> {
    let nonce: [u8; NONCE_BYTES] = decode_exact("nonce", &file.nonce, NONCE_BYTES)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("The Rho Vault nonce has an invalid length."))?;
    let nonce = XNonce::from(nonce);
    let mut ciphertext = Zeroizing::new(
        BASE64
            .decode(&file.ciphertext)
            .context("The Rho Vault ciphertext is invalid.")?,
    );
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| anyhow::anyhow!("Rho could not open the credential vault."))?;
    let plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext.as_slice(),
                aad: &aad(file)?,
            },
        )
        .map_err(|_| {
            anyhow::anyhow!("The Rho Vault password is incorrect or the vault was changed.")
        })?;
    ciphertext.zeroize();
    let plaintext = Zeroizing::new(plaintext);
    let payload: CredentialVaultPayload =
        serde_json::from_slice(&plaintext).context("The Rho Vault contents are invalid.")?;
    validate_payload(file, &payload)?;
    Ok(payload)
}

fn validate_payload(file: &CredentialVaultFile, payload: &CredentialVaultPayload) -> Result<()> {
    ensure!(
        payload.entries.len() <= MAX_ENTRY_COUNT,
        "The Rho Vault contains too many entries."
    );
    for (provider_id, credential) in &payload.entries {
        validate_provider_id(provider_id)?;
        validate_credential(credential)?;
    }
    let entry_ids: Vec<&str> = payload.entries.keys().map(String::as_str).collect();
    let header_ids: Vec<&str> = file.entry_ids.iter().map(String::as_str).collect();
    ensure!(
        entry_ids == header_ids,
        "The Rho Vault entry index does not match its contents."
    );
    Ok(())
}

fn encrypted_file(
    salt: &[u8; SALT_BYTES],
    key: &[u8; KEY_BYTES],
    payload: &CredentialVaultPayload,
) -> Result<CredentialVaultFile> {
    ensure!(
        payload.entries.len() <= MAX_ENTRY_COUNT,
        "The Rho Vault contains too many entries."
    );
    let nonce_bytes = rand::random::<[u8; NONCE_BYTES]>();
    let nonce = XNonce::from(nonce_bytes);
    let mut file = CredentialVaultFile {
        schema_version: VAULT_SCHEMA_VERSION,
        kdf: VaultKdfHeader::default(),
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce_bytes),
        entry_ids: payload.entries.keys().cloned().collect(),
        ciphertext: String::new(),
    };
    for (provider_id, credential) in &payload.entries {
        validate_provider_id(provider_id)?;
        validate_credential(credential)?;
    }
    let plaintext = Zeroizing::new(
        serde_json::to_vec(payload).context("Rho could not prepare the credential vault.")?,
    );
    ensure!(
        plaintext.len() <= MAX_VAULT_BYTES as usize,
        "The Rho Vault contents exceed the size limit."
    );
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| anyhow::anyhow!("Rho could not encrypt the credential vault."))?;
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext.as_slice(),
                aad: &aad(&file)?,
            },
        )
        .map_err(|_| anyhow::anyhow!("Rho could not encrypt the credential vault."))?;
    file.ciphertext = BASE64.encode(ciphertext);
    validate_header(&file)?;
    Ok(file)
}

fn serialized_file(file: &CredentialVaultFile) -> Result<Vec<u8>> {
    let bytes =
        serde_json::to_vec_pretty(file).context("Rho could not serialize the credential vault.")?;
    ensure!(
        bytes.len() <= MAX_VAULT_BYTES as usize,
        "The Rho Vault exceeds the size limit."
    );
    Ok(bytes)
}

#[cfg(unix)]
fn private_permissions(file: &File) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .context("Rho could not protect the credential vault file.")
}

#[cfg(not(unix))]
fn private_permissions(_file: &File) -> Result<()> {
    Ok(())
}

fn sync_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .context("The Rho Vault path has no parent directory.")?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .context("Rho could not durably save the credential vault directory.")?;
    Ok(())
}

fn write_new_vault(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .context("The Rho Vault path has no parent directory.")?;
    fs::create_dir_all(parent).context("Rho could not create the credential vault directory.")?;
    let mut temp = NamedTempFile::new_in(parent)
        .context("Rho could not create the credential vault temporary file.")?;
    private_permissions(temp.as_file())?;
    temp.write_all(bytes)
        .context("Rho could not write the credential vault.")?;
    temp.as_file()
        .sync_all()
        .context("Rho could not durably write the credential vault.")?;
    temp.persist_noclobber(path).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            anyhow::anyhow!("The Rho Vault is already initialized.")
        } else {
            anyhow::anyhow!(error.error).context("Rho could not initialize the credential vault.")
        }
    })?;
    private_permissions(&OpenOptions::new().read(true).open(path)?)?;
    sync_parent(path)
}

fn replace_vault(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .context("The Rho Vault path has no parent directory.")?;
    let mut temp = NamedTempFile::new_in(parent)
        .context("Rho could not create the credential vault temporary file.")?;
    private_permissions(temp.as_file())?;
    temp.write_all(bytes)
        .context("Rho could not write the credential vault.")?;
    temp.as_file()
        .sync_all()
        .context("Rho could not durably write the credential vault.")?;
    temp.persist(path)
        .map_err(|error| anyhow::anyhow!(error.error))
        .context("Rho could not replace the credential vault.")?;
    private_permissions(&OpenOptions::new().read(true).open(path)?)?;
    sync_parent(path)
}

fn locked_key<'a>(
    data_dir: &Path,
    sessions: &'a HashMap<PathBuf, Zeroizing<[u8; KEY_BYTES]>>,
) -> Result<&'a [u8; KEY_BYTES]> {
    sessions
        .get(&normalized_data_dir(data_dir))
        .map(|key| &**key)
        .context("Unlock the Rho Vault before managing API keys.")
}

fn ensure_automatically_open(data_dir: &Path) -> Result<()> {
    if session_guard().contains_key(&normalized_data_dir(data_dir)) {
        return Ok(());
    }
    let password = local_password(data_dir)?;
    if vault_path(data_dir).exists() {
        return unlock(data_dir, &password);
    }
    match initialize(data_dir, &password) {
        Ok(()) => Ok(()),
        Err(_) if vault_path(data_dir).exists() => unlock(data_dir, &password),
        Err(error) => Err(error),
    }
}

pub(crate) fn initialize(data_dir: &Path, password: &str) -> Result<()> {
    validate_password(password)?;
    let path = vault_path(data_dir);
    ensure!(!path.exists(), "The Rho Vault is already initialized.");
    let salt = rand::random::<[u8; SALT_BYTES]>();
    let key = derive_key(password, &salt, &VaultKdfHeader::default())?;
    let file = encrypted_file(&salt, &key, &CredentialVaultPayload::default())?;
    write_new_vault(&path, &serialized_file(&file)?)?;
    session_guard().insert(normalized_data_dir(data_dir), key);
    Ok(())
}

pub(crate) fn unlock(data_dir: &Path, password: &str) -> Result<()> {
    validate_password(password)?;
    let file = read_vault_file(data_dir)?;
    let salt = decode_exact("salt", &file.salt, SALT_BYTES)?;
    let key = derive_key(password, &salt, &file.kdf)?;
    decrypt_payload(&file, &key)?;
    session_guard().insert(normalized_data_dir(data_dir), key);
    Ok(())
}

#[cfg(test)]
pub(crate) fn is_unlocked(data_dir: &Path) -> bool {
    session_guard().contains_key(&normalized_data_dir(data_dir))
}

pub(crate) fn clear_all_sessions() {
    session_guard().clear();
}

pub(crate) fn status(data_dir: &Path, provider_id: &str) -> CredentialVaultStatus {
    if !vault_path(data_dir).exists() && !local_key_path(data_dir).exists() {
        return CredentialVaultStatus::Missing;
    }
    if ensure_automatically_open(data_dir).is_err() {
        return CredentialVaultStatus::Unavailable;
    }
    let Ok(file) = read_vault_file(data_dir) else {
        return CredentialVaultStatus::Unavailable;
    };
    let sessions = session_guard();
    if let Some(key) = sessions.get(&normalized_data_dir(data_dir)) {
        match decrypt_payload(&file, key) {
            Ok(payload) if payload.entries.contains_key(provider_id) => {
                CredentialVaultStatus::Saved
            }
            Ok(_) => CredentialVaultStatus::Missing,
            Err(_) => CredentialVaultStatus::Unavailable,
        }
    } else {
        CredentialVaultStatus::Unavailable
    }
}

pub(crate) fn get(data_dir: &Path, provider_id: &str) -> Result<Option<String>> {
    validate_provider_id(provider_id)?;
    if !vault_path(data_dir).exists() && !local_key_path(data_dir).exists() {
        return Ok(None);
    }
    ensure_automatically_open(data_dir)?;
    let sessions = session_guard();
    let key = locked_key(data_dir, &sessions)?;
    let file = read_vault_file(data_dir)?;
    let payload = decrypt_payload(&file, key)?;
    Ok(payload.entries.get(provider_id).cloned())
}

pub(crate) fn set(data_dir: &Path, provider_id: &str, credential: &str) -> Result<()> {
    set_with_writer(data_dir, provider_id, credential, replace_vault)
}

fn set_with_writer<F>(data_dir: &Path, provider_id: &str, credential: &str, write: F) -> Result<()>
where
    F: FnOnce(&Path, &[u8]) -> Result<()>,
{
    validate_provider_id(provider_id)?;
    validate_credential(credential)?;
    ensure_automatically_open(data_dir)?;
    let sessions = session_guard();
    let key = locked_key(data_dir, &sessions)?;
    let file = read_vault_file(data_dir)?;
    let salt = decode_exact("salt", &file.salt, SALT_BYTES)?;
    let mut payload = decrypt_payload(&file, key)?;
    payload
        .entries
        .insert(provider_id.to_string(), credential.to_string());
    let replacement = encrypted_file(salt.as_slice().try_into()?, key, &payload)?;
    write(&vault_path(data_dir), &serialized_file(&replacement)?)
}

pub(crate) fn delete(data_dir: &Path, provider_id: &str) -> Result<()> {
    validate_provider_id(provider_id)?;
    if !vault_path(data_dir).exists() && !local_key_path(data_dir).exists() {
        return Ok(());
    }
    ensure_automatically_open(data_dir)?;
    let sessions = session_guard();
    let key = locked_key(data_dir, &sessions)?;
    let file = read_vault_file(data_dir)?;
    let salt = decode_exact("salt", &file.salt, SALT_BYTES)?;
    let mut payload = decrypt_payload(&file, key)?;
    payload.entries.remove(provider_id);
    let replacement = encrypted_file(salt.as_slice().try_into()?, key, &payload)?;
    replace_vault(&vault_path(data_dir), &serialized_file(&replacement)?)
}

#[cfg(test)]
pub(crate) fn clear_session_for_test(data_dir: &Path) {
    session_guard().remove(&normalized_data_dir(data_dir));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_unlock_and_mutate_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        initialize(directory.path(), "correct horse battery staple").unwrap();
        assert!(is_unlocked(directory.path()));
        assert_eq!(
            status(directory.path(), "provider-a"),
            CredentialVaultStatus::Missing
        );

        set(directory.path(), "provider-a", "secret-first").unwrap();
        assert_eq!(
            get(directory.path(), "provider-a").unwrap().as_deref(),
            Some("secret-first")
        );
        let first: CredentialVaultFile =
            serde_json::from_slice(&fs::read(vault_path(directory.path())).unwrap()).unwrap();
        set(directory.path(), "provider-a", "secret-second").unwrap();
        let second: CredentialVaultFile =
            serde_json::from_slice(&fs::read(vault_path(directory.path())).unwrap()).unwrap();
        assert_ne!(first.nonce, second.nonce);

        clear_session_for_test(directory.path());
        assert_eq!(
            status(directory.path(), "provider-a"),
            CredentialVaultStatus::Unavailable
        );
        assert!(get(directory.path(), "provider-a").is_err());
        assert!(unlock(directory.path(), "wrong password value").is_err());
        unlock(directory.path(), "correct horse battery staple").unwrap();
        assert_eq!(
            get(directory.path(), "provider-a").unwrap().as_deref(),
            Some("secret-second")
        );

        delete(directory.path(), "provider-a").unwrap();
        assert_eq!(get(directory.path(), "provider-a").unwrap(), None);
    }

    #[test]
    fn duplicate_initialize_and_tampering_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        initialize(directory.path(), "correct horse battery staple").unwrap();
        assert!(initialize(directory.path(), "another valid password").is_err());
        set(directory.path(), "provider-a", "secret-first").unwrap();
        clear_session_for_test(directory.path());

        let path = vault_path(directory.path());
        let mut file: CredentialVaultFile =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        file.entry_ids[0] = "provider-b".to_string();
        fs::write(&path, serde_json::to_vec_pretty(&file).unwrap()).unwrap();
        assert!(unlock(directory.path(), "correct horse battery staple").is_err());
        assert!(!is_unlocked(directory.path()));
    }

    #[test]
    fn failed_replacement_preserves_old_ciphertext_and_provider_isolation() {
        let directory = tempfile::tempdir().unwrap();
        initialize(directory.path(), "correct horse battery staple").unwrap();
        set(directory.path(), "provider-a", "secret-a").unwrap();
        set(directory.path(), "provider-b", "secret-b").unwrap();
        let before = fs::read(vault_path(directory.path())).unwrap();

        let failure = set_with_writer(
            directory.path(),
            "provider-a",
            "replacement-a",
            |_path, _bytes| anyhow::bail!("injected durable write failure"),
        );
        assert!(failure.is_err());
        assert_eq!(fs::read(vault_path(directory.path())).unwrap(), before);
        assert_eq!(
            get(directory.path(), "provider-a").unwrap().as_deref(),
            Some("secret-a")
        );
        assert_eq!(
            get(directory.path(), "provider-b").unwrap().as_deref(),
            Some("secret-b")
        );
    }

    #[test]
    fn local_store_initializes_and_reopens_without_user_password() {
        let directory = tempfile::tempdir().unwrap();
        assert!(!vault_path(directory.path()).exists());
        assert!(!local_key_path(directory.path()).exists());

        set(directory.path(), "provider-a", "secret-a").unwrap();
        assert!(vault_path(directory.path()).exists());
        assert!(local_key_path(directory.path()).exists());
        clear_session_for_test(directory.path());

        assert_eq!(
            get(directory.path(), "provider-a").unwrap().as_deref(),
            Some("secret-a")
        );
        assert_eq!(
            status(directory.path(), "provider-a"),
            CredentialVaultStatus::Saved
        );
    }

    #[test]
    fn bounds_and_ciphertext_tampering_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        assert!(initialize(directory.path(), "too-short").is_err());
        initialize(directory.path(), "correct horse battery staple").unwrap();
        assert!(
            set(
                directory.path(),
                "provider-a",
                &"x".repeat(MAX_CREDENTIAL_BYTES + 1)
            )
            .is_err()
        );
        set(directory.path(), "provider-a", "secret-a").unwrap();
        clear_session_for_test(directory.path());

        let path = vault_path(directory.path());
        let mut file: CredentialVaultFile =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let mut ciphertext = BASE64.decode(&file.ciphertext).unwrap();
        ciphertext[0] ^= 0x01;
        file.ciphertext = BASE64.encode(ciphertext);
        fs::write(&path, serde_json::to_vec_pretty(&file).unwrap()).unwrap();
        assert!(unlock(directory.path(), "correct horse battery staple").is_err());
        assert!(!is_unlocked(directory.path()));
    }

    #[cfg(unix)]
    #[test]
    fn local_credential_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        set(directory.path(), "provider-a", "secret-a").unwrap();
        for path in [
            vault_path(directory.path()),
            local_key_path(directory.path()),
        ] {
            let mode = fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }
}
