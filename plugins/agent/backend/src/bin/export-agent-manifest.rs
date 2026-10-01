fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = std::env::args_os()
        .nth(1)
        .ok_or("Expected manifest output path")?;
    let manifest = rho_agent_backend::manifest::manifest();
    manifest.validate()?;
    // The protocol limits the bytes read before JSON parsing. Repeated public
    // schemas fit that bound, but pretty-printing can exceed it with whitespace.
    let encoded = serde_json::to_string(&manifest)? + "\n";
    if encoded.len() > rho_plugin_sdk::protocol::MAX_MANIFEST_BYTES {
        return Err("Encoded Agent manifest exceeds the public protocol byte limit".into());
    }
    std::fs::write(output, encoded)?;
    Ok(())
}
