use async_trait::async_trait;
use rho_adapter_skills::*;
use rho_contract::*;
use rho_skills::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct Application {
    bindings: Mutex<Vec<ApplicationMethodBinding>>,
    reads: Mutex<Vec<ApplicationSkillReadReceipt>>,
}
#[async_trait]
impl MethodBindingPort for Application {
    async fn method_bindings(
        &self,
        _: &CallContext,
    ) -> Result<Vec<ApplicationMethodBinding>, String> {
        Ok(self.bindings.lock().unwrap().clone())
    }
    async fn record_skill_read(
        &self,
        _: &CallContext,
        receipt: &ApplicationSkillReadReceipt,
    ) -> Result<(), String> {
        self.reads.lock().unwrap().push(receipt.clone());
        Ok(())
    }
}
struct Capabilities;
#[async_trait]
impl SkillCapabilityPort for Capabilities {
    async fn target_is_current(&self, _: &CallContext, target: &TargetRef) -> Result<bool, String> {
        Ok(target.identity == "current")
    }
    async fn available_capabilities(
        &self,
        _: &CallContext,
        _: Option<&TargetRef>,
    ) -> Result<Vec<CapabilityRef>, String> {
        Ok(vec![])
    }
}
fn context(id: &str) -> CallContext {
    serde_json::from_value(serde_json::json!({"caller":{"kind":"agent","id":id},"principal":null,"scopes":["skill.read"],"connection_id":"test","correlation_id":null,"causation_id":null,"trace_parent":null})).unwrap()
}
fn scope(root: &std::path::Path, context: &CallContext, dir: &str) -> SkillScope {
    SkillScope {
        project_root: root.canonicalize().unwrap().to_string_lossy().into(),
        working_directory: dir.into(),
        principal: serde_json::to_string(context.principal()).unwrap(),
    }
}
fn make_skill(root: &std::path::Path, name: &str, description: &str) -> std::path::PathBuf {
    let path = root.join(name);
    fs::create_dir_all(path.join("scripts")).unwrap();
    fs::write(path.join("SKILL.md"),format!("---\nname: {name}\ndescription: {description}\nallowed-tools: Bash(*)\nmetadata:\n  author: test\n---\nChoose a method from the observed data.\n")).unwrap();
    fs::write(path.join("scripts/run.R"), "stop('MUST NOT EXECUTE')\n").unwrap();
    path
}
fn list(dir: &str) -> SkillListArguments {
    SkillListArguments {
        working_directory: dir.into(),
        filter: String::new(),
        source_id: None,
        cursor: None,
        limit: 20,
    }
}
fn read(skill: &SkillSummary, kind: SkillReadKind) -> SkillReadArguments {
    SkillReadArguments {
        working_directory: ".".into(),
        skill_ref: skill.skill_ref.clone(),
        expected_digest: skill.skill_digest.clone(),
        kind,
        resource_path: None,
        expected_resource_digest: None,
        offset: 0,
        limit_bytes: 16,
        resource_limit: 1,
        external_task_ref: Some("task".into()),
    }
}
fn owner(
    root: &std::path::Path,
    sources: Vec<Arc<dyn SkillSource>>,
    app: Arc<Application>,
) -> SkillOwner {
    SkillOwner::new(
        root.canonicalize().unwrap().to_string_lossy().into(),
        sources,
        app,
        Arc::new(Capabilities),
    )
    .unwrap()
}

#[tokio::test]
async fn standard_sources_pages_same_names_and_resource_identity_changes() {
    let project = tempfile::tempdir().unwrap();
    let user = tempfile::tempdir().unwrap();
    let ctx = context("caller");
    let local = make_skill(
        &project.path().join(".agents/skills"),
        "investigate",
        "Inspect local evidence",
    );
    make_skill(
        &user.path().join(".agents/skills"),
        "investigate",
        "Inspect user evidence",
    );
    fs::create_dir_all(project.path().join("analysis/subdir")).unwrap();
    make_skill(
        &project.path().join("analysis/.agents/skills"),
        "analyze",
        "Analyze child data",
    );
    let app = Arc::new(Application::default());
    let source = Arc::new(FilesystemSkillSource::new(project.path(), Some(user.path())).unwrap());
    let owner = owner(project.path(), vec![source], app.clone());
    let mut args = list("analysis/subdir");
    args.limit = 1;
    let first = owner.list(&ctx, &args).await.unwrap();
    let mut all = first.skills.clone();
    let mut cursor = first.next_cursor;
    while let Some(next) = cursor {
        args.cursor = Some(next);
        let page = owner.list(&ctx, &args).await.unwrap();
        all.extend(page.skills);
        cursor = page.next_cursor;
    }
    assert_eq!(all.len(), 3);
    assert_eq!(
        all.iter()
            .filter(|s| s.metadata.name == "investigate")
            .count(),
        2
    );
    assert_eq!(
        all.iter()
            .map(|s| &s.source.source_ref)
            .collect::<BTreeSet<_>>()
            .len(),
        3
    );
    assert!(all.iter().all(|s| s.metadata.dependencies == "undeclared"));
    assert!(
        all.iter()
            .all(|s| s.metadata.allowed_tools.as_deref() == Some("Bash(*)"))
    );
    let root = owner.list(&ctx, &list(".")).await.unwrap();
    assert_eq!(root.skills.len(), 2);
    let skill = root
        .skills
        .iter()
        .find(|s| {
            s.source
                .location
                .starts_with(project.path().canonicalize().unwrap().to_str().unwrap())
        })
        .unwrap();
    let mut manifest_args = read(skill, SkillReadKind::Manifest);
    let one = owner.read(&ctx, &manifest_args).await.unwrap();
    assert_eq!(one.resources.len(), 1);
    manifest_args.offset = one.next_offset.unwrap();
    let two = owner.read(&ctx, &manifest_args).await.unwrap();
    assert_eq!(two.resources[0].path, "scripts/run.R");
    let mut body_args = read(skill, SkillReadKind::Text);
    body_args.limit_bytes = 11;
    let mut content = String::new();
    loop {
        let page = owner.read(&ctx, &body_args).await.unwrap();
        content.push_str(page.text.as_ref().unwrap());
        if let Some(offset) = page.next_offset {
            body_args.offset = offset;
        } else {
            break;
        }
    }
    assert_eq!(content, fs::read_to_string(local.join("SKILL.md")).unwrap());
    assert!(!app.reads.lock().unwrap().is_empty());
    assert!(
        owner
            .read(&context("other"), &read(skill, SkillReadKind::Text))
            .await
            .is_err()
    );
    fs::write(local.join("scripts/run.R"), "stop('ALTERED CONTENT')\n").unwrap();
    assert!(
        owner
            .read(&ctx, &read(skill, SkillReadKind::Text))
            .await
            .is_err()
    );
    let fresh = owner.list(&ctx, &list(".")).await.unwrap();
    let updated = fresh
        .skills
        .iter()
        .find(|s| s.source.source_ref == skill.source.source_ref)
        .unwrap();
    assert_ne!(updated.skill_ref, skill.skill_ref);
    assert_eq!(updated.skill_digest, skill.skill_digest);
    fs::write(
        local.join("SKILL.md"),
        "---\nname: investigate\ndescription: Changed\n---\nBody\n",
    )
    .unwrap();
    assert!(
        owner
            .read(&ctx, &read(updated, SkillReadKind::Manifest))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn host_sources_preserve_status_scope_revision_and_binary_resources() {
    let project = tempfile::tempdir().unwrap();
    let ctx = context("caller");
    let scope = scope(project.path(), &ctx, ".");
    let source = Arc::new(
        HostProvidedSkillSource::new(
            "codex-plugin".into(),
            scope.project_root.clone(),
            scope.principal.clone(),
        )
        .unwrap(),
    );
    let package=HostProvidedPackage {source_key:"installed/plugin/unseen-method".into(),canonical_resource:"host-resource://plugin/unseen-method".into(),location:"host-resource://plugin/unseen-method/SKILL.md".into(),enablement:SkillEnablement::Enabled,reason:None,resources:BTreeMap::from([("SKILL.md".into(),b"---\nname: unseen-method\ndescription: Previously unknown method\n---\nRead evidence.\n".to_vec()),("assets/data.bin".into(),vec![0,255,128,42])])};
    assert_eq!(source.replace(0, vec![package.clone()]).unwrap(), 1);
    assert!(source.replace(0, vec![]).is_err());
    let app = Arc::new(Application::default());
    let owner = owner(project.path(), vec![source.clone()], app);
    let listed = owner.list(&ctx, &list(".")).await.unwrap();
    let skill = &listed.skills[0];
    let mut manifest = read(skill, SkillReadKind::Manifest);
    manifest.resource_limit = 10;
    let resources = owner.read(&ctx, &manifest).await.unwrap();
    let binary = resources
        .resources
        .iter()
        .find(|r| r.path == "assets/data.bin")
        .unwrap();
    let mut binary_args = read(skill, SkillReadKind::Bytes);
    binary_args.resource_path = Some(binary.path.clone());
    binary_args.expected_resource_digest = Some(binary.sha256.clone());
    assert_eq!(
        owner.read(&ctx, &binary_args).await.unwrap().bytes,
        Some(vec![0, 255, 128, 42])
    );
    assert!(
        owner
            .list(&context("other"), &list("."))
            .await
            .unwrap()
            .skills
            .is_empty()
    );
    let mut disabled = package.clone();
    disabled.enablement = SkillEnablement::Disabled;
    disabled.reason = Some("Disabled by actual host".into());
    source.replace(1, vec![disabled]).unwrap();
    assert!(
        owner
            .read(&ctx, &read(skill, SkillReadKind::Text))
            .await
            .is_err()
    );
    let disabled = owner.list(&ctx, &list(".")).await.unwrap();
    assert_eq!(
        disabled.skills[0].source.enablement,
        SkillEnablement::Disabled
    );
    assert!(
        owner
            .read(&ctx, &read(&disabled.skills[0], SkillReadKind::Text))
            .await
            .is_err()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn project_roots_and_resources_enforce_symlink_containment() {
    use std::os::unix::fs::symlink;
    let project = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let ctx = context("caller");
    let scope = scope(project.path(), &ctx, ".");
    make_skill(external.path(), "outside", "Outside the project");
    fs::create_dir_all(project.path().join(".agents")).unwrap();
    symlink(external.path(), project.path().join(".agents/skills")).unwrap();
    let source = FilesystemSkillSource::new(project.path(), None).unwrap();
    let inventory = source.discover(&scope).await.unwrap();
    assert!(inventory.packages.is_empty());
    assert_eq!(inventory.notices[0].code, "containment");
    fs::remove_file(project.path().join(".agents/skills")).unwrap();
    let skill = make_skill(
        &project.path().join(".agents/skills"),
        "contained",
        "Contained method",
    );
    symlink(
        external.path().join("outside/SKILL.md"),
        skill.join("references.txt"),
    )
    .unwrap();
    let inventory = source.discover(&scope).await.unwrap();
    assert!(inventory.packages.is_empty());
    assert!(!inventory.notices.is_empty());
    fs::remove_file(skill.join("references.txt")).unwrap();
    symlink(skill.join("scripts/run.R"), skill.join("same-script.R")).unwrap();
    let inventory = source.discover(&scope).await.unwrap();
    assert_eq!(inventory.packages.len(), 1);
    assert_eq!(inventory.packages[0].resources.len(), 3);
    let package = &inventory.packages[0];
    fs::remove_file(skill.join("same-script.R")).unwrap();
    symlink(
        external.path().join("outside/SKILL.md"),
        skill.join("same-script.R"),
    )
    .unwrap();
    assert!(source.read(&scope, package, "SKILL.md").await.is_err());
}

#[tokio::test]
async fn explicit_ancestor_exclusion_disabled_methods_and_missing_capabilities_are_reported() {
    let project = tempfile::tempdir().unwrap();
    let ctx = context("caller");
    make_skill(
        &project.path().join(".agents/skills"),
        "method",
        "A selectable method",
    );
    fs::create_dir_all(project.path().join("analysis")).unwrap();
    let source = Arc::new(FilesystemSkillSource::new(project.path(), None).unwrap());
    let app = Arc::new(Application::default());
    let owner = owner(project.path(), vec![source], app.clone());
    let listed = owner.list(&ctx, &list(".")).await.unwrap();
    let skill = &listed.skills[0];
    let binding:ApplicationMethodBinding=serde_json::from_value(serde_json::json!({"binding_id":"selected","version":"v1","working_directory":"analysis","external_goal_ref":null,"external_task_ref":null,"external_actor_ref":null,"skill_ref":skill.skill_ref,"source_ref":skill.source.source_ref,"resources":[],"modules":["workspace"],"capabilities":[],"required_capabilities":[{"id":"workspace.run_r","version":1}],"target":null,"excluded":false})).unwrap();
    let mut excluded = binding.clone();
    excluded.binding_id = "excluded".into();
    excluded.working_directory = ".".into();
    excluded.excluded = true;
    app.bindings.lock().unwrap().extend([binding, excluded]);
    let resolved = owner
        .resolve_context(
            &ctx,
            &ResolveContextArguments {
                working_directory: "analysis".into(),
                external_task_ref: None,
                target: None,
                cursor: None,
                limit: 20,
            },
        )
        .await
        .unwrap();
    let selected = resolved
        .methods
        .iter()
        .find(|m| m.binding_id == "selected")
        .unwrap();
    assert!(!selected.valid);
    assert!(
        selected
            .conditions
            .iter()
            .any(|c| c.code == "excluded_by_ancestor")
    );
    assert!(
        selected
            .conditions
            .iter()
            .any(|c| c.code == "capability_unavailable")
    );
    assert!(
        !selected
            .conditions
            .iter()
            .any(|c| c.code == "skill_changed")
    );
}

#[test]
fn standard_frontmatter_supports_yaml_blocks_and_does_not_parse_the_body() {
    let mut content=b"---\r\nname: standard-method\r\ndescription: >\r\n  First line\r\n  second line\r\nmetadata:\r\n  author: user\r\n---\r\n".to_vec();
    content.extend("界".repeat(30000).as_bytes());
    let yaml = frontmatter(&content).unwrap();
    let parsed = parse_frontmatter(&yaml).unwrap();
    assert!(parsed.description.contains("First line second line"));
    assert_eq!(parsed.metadata["author"], "user");
    assert_eq!(parsed.dependencies, "undeclared");
    assert!(parse_frontmatter("name: bad--name\ndescription: test").is_err());
    assert!(frontmatter(b"name: no-frontmatter").is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn private_host_paths_and_equivalent_host_disablement_cannot_be_bypassed() {
    use std::os::unix::fs::symlink;
    let project = tempfile::tempdir().unwrap();
    let ctx = context("caller");
    let package = make_skill(
        &project.path().join(".agents/skills"),
        "method",
        "Method evidence",
    );
    fs::create_dir(package.join("target")).unwrap();
    fs::write(package.join("target/evidence.txt"), "permitted resource").unwrap();
    let native = Arc::new(FilesystemSkillSource::new(project.path(), None).unwrap());
    let scope = scope(project.path(), &ctx, ".");
    let inventory = native.discover(&scope).await.unwrap();
    assert!(
        inventory.packages[0]
            .resources
            .iter()
            .any(|r| r.path == "target/evidence.txt")
    );
    let hosted = Arc::new(
        HostProvidedSkillSource::new(
            "actual-host".into(),
            scope.project_root.clone(),
            scope.principal.clone(),
        )
        .unwrap(),
    );
    hosted
        .replace(
            0,
            vec![HostProvidedPackage {
                source_key: "same-method".into(),
                canonical_resource: package.canonicalize().unwrap().to_string_lossy().into(),
                location: "host-resource://same-method/SKILL.md".into(),
                enablement: SkillEnablement::Rejected,
                reason: Some("Rejected by the actual host".into()),
                resources: BTreeMap::from([(
                    "SKILL.md".into(),
                    fs::read(package.join("SKILL.md")).unwrap(),
                )]),
            }],
        )
        .unwrap();
    let owner = owner(
        project.path(),
        vec![native.clone(), hosted],
        Arc::new(Application::default()),
    );
    let listed = owner.list(&ctx, &list(".")).await.unwrap();
    assert_eq!(listed.skills.len(), 2);
    assert!(listed.skills.iter().all(|s| !s.available));
    let local = listed
        .skills
        .iter()
        .find(|s| s.source.source_id == "local-standard")
        .unwrap();
    assert_eq!(local.source.enablement, SkillEnablement::Enabled);
    assert!(!local.unavailable_reasons.is_empty());
    assert!(
        owner
            .read(&ctx, &read(local, SkillReadKind::Text))
            .await
            .is_err()
    );
    let secret = package.join("secret-store");
    fs::create_dir(&secret).unwrap();
    fs::write(secret.join("token"), "private").unwrap();
    let protected = FilesystemSkillSource::new(project.path(), None)
        .unwrap()
        .with_excluded_paths(vec![secret])
        .unwrap();
    assert!(
        protected
            .discover(&scope)
            .await
            .unwrap()
            .packages
            .is_empty()
    );
    let rho = project.path().join(".rho");
    fs::create_dir(&rho).unwrap();
    fs::write(
        rho.join("SKILL.md"),
        fs::read(package.join("SKILL.md")).unwrap(),
    )
    .unwrap();
    fs::remove_dir_all(&package).unwrap();
    symlink(&rho, &package).unwrap();
    assert!(native.discover(&scope).await.unwrap().packages.is_empty());
}

#[tokio::test]
async fn native_host_manifest_reads_exact_original_roots_and_observes_live_changes() {
    let project = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let ctx = context("caller");
    let scope = scope(project.path(), &ctx, ".");
    let declared = make_skill(external.path(), "declared-method", "Native host method");
    make_skill(
        external.path(),
        "undiscovered-method",
        "Must not be scanned by the manifest adapter",
    );
    let manifest_path = project.path().join("host-skills.json");
    let mut manifest = HostDiscoveredSkills {
        provider_id: "native-codex".into(),
        skills: vec![HostDiscoveredSkill {
            source_key: "plugin/reference".into(),
            root_path: declared.to_string_lossy().into(),
            source_kind: HostSkillSourceKind::Plugin,
            enablement: SkillEnablement::Enabled,
            reason: None,
        }],
    };
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let source = Arc::new(
        HostDiscoveredSkillSource::from_manifest(
            project.path(),
            scope.principal.clone(),
            &manifest_path,
            vec![],
        )
        .unwrap(),
    );
    let inventory = source.discover(&scope).await.unwrap();
    assert_eq!(inventory.packages.len(), 1);
    assert_eq!(inventory.packages[0].key, "plugin/reference");
    assert_eq!(
        source
            .read(&scope, &inventory.packages[0], "SKILL.md")
            .await
            .unwrap(),
        fs::read(declared.join("SKILL.md")).unwrap()
    );
    let owner = owner(
        project.path(),
        vec![source.clone()],
        Arc::new(Application::default()),
    );
    let listed = owner.list(&ctx, &list(".")).await.unwrap();
    let skill = &listed.skills[0];
    fs::write(declared.join("scripts/run.R"), "changed script\n").unwrap();
    assert!(
        owner
            .read(&ctx, &read(skill, SkillReadKind::Text))
            .await
            .is_err()
    );
    let current = owner.list(&ctx, &list(".")).await.unwrap();
    manifest.skills[0].enablement = SkillEnablement::Disabled;
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(
        owner
            .read(&ctx, &read(&current.skills[0], SkillReadKind::Text))
            .await
            .is_err()
    );
    manifest.skills[0].source_kind = HostSkillSourceKind::Project;
    manifest.skills[0].enablement = SkillEnablement::Enabled;
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let refused = source.discover(&scope).await.unwrap();
    assert!(refused.packages.is_empty());
    assert!(!refused.notices.is_empty());
}

#[tokio::test]
async fn binding_validation_requires_current_resources_target_and_explicit_unexclude() {
    let project = tempfile::tempdir().unwrap();
    let ctx = context("caller");
    let path = make_skill(
        &project.path().join(".agents/skills"),
        "method",
        "Method binding",
    );
    fs::create_dir(project.path().join("analysis")).unwrap();
    let app = Arc::new(Application::default());
    let owner = owner(
        project.path(),
        vec![Arc::new(
            FilesystemSkillSource::new(project.path(), None).unwrap(),
        )],
        app.clone(),
    );
    let listed = owner.list(&ctx, &list(".")).await.unwrap();
    let skill = &listed.skills[0];
    let mut binding:ApplicationMethodBinding=serde_json::from_value(serde_json::json!({"binding_id":"selection","version":"v1","working_directory":".","external_goal_ref":null,"external_task_ref":null,"external_actor_ref":null,"skill_ref":skill.skill_ref,"source_ref":skill.source.source_ref,"resources":[],"modules":[],"capabilities":[],"required_capabilities":[],"target":null,"excluded":false})).unwrap();
    owner.validate_binding(&ctx, &binding).await.unwrap();
    binding.target = Some(TargetRef {
        kind: "workspace".into(),
        identity: "old-session".into(),
    });
    assert!(owner.validate_binding(&ctx, &binding).await.is_err());
    binding.target = None;
    let mut exclusion = binding.clone();
    exclusion.excluded = true;
    app.bindings.lock().unwrap().push(exclusion.clone());
    owner.validate_binding(&ctx, &binding).await.unwrap();
    binding.binding_id = "child-selection".into();
    binding.working_directory = "analysis".into();
    assert!(owner.validate_binding(&ctx, &binding).await.is_err());
    app.bindings.lock().unwrap().clear();
    owner.validate_binding(&ctx, &binding).await.unwrap();
    fs::write(path.join("scripts/run.R"), "different content\n").unwrap();
    assert!(owner.validate_binding(&ctx, &binding).await.is_err());
}
