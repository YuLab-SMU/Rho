use super::*;
use std::{
    collections::BTreeSet,
    path::{Component, PathBuf},
};

const PAGE: u32 = 32;
const PAGES: usize = 128;

fn data(observation: Value, partial: bool) -> Result<Value, String> {
    if observation["status"] != "ready"
        || !(observation["completeness"] == "complete"
            || partial && observation["completeness"] == "partial")
    {
        return Err("A reference observation is unavailable or incomplete".into());
    }
    observation
        .get("data")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| "Reference observation has no data".into())
}

/// Keep the lexical path as well as its current filesystem alias. Missing tails
/// do not remove a stored reference; a dangling symlink remains unknown.
fn path_variants(value: &str) -> Result<Vec<PathBuf>, String> {
    let path = PathBuf::from(value);
    if value.len() > 4096
        || !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
    {
        return Err("A reference path is not an absolute normalized path".into());
    }
    let mut existing = path.as_path();
    let mut tail = Vec::new();
    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tail.push(
                    existing
                        .file_name()
                        .ok_or("Reference path has no existing ancestor")?
                        .to_owned(),
                );
                existing = existing
                    .parent()
                    .ok_or("Reference path has no existing ancestor")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let mut resolved = existing.canonicalize().map_err(error)?;
    for name in tail.into_iter().rev() {
        resolved.push(name);
    }
    Ok(vec![path, resolved])
}

struct References {
    material: Vec<PathBuf>,
    count: usize,
}
impl References {
    fn new(paths: &[String]) -> Result<Self, String> {
        let mut material = Vec::new();
        for path in paths {
            material.extend(path_variants(path)?);
        }
        Ok(Self { material, count: 0 })
    }
    fn protect(&mut self, path: &str) -> Result<(), String> {
        self.count += 1;
        if self.count > 4096 {
            return Err("Reference paths exceeded their bounded inventory".into());
        }
        if path_variants(path)?.iter().any(|path| {
            self.material
                .iter()
                .any(|material| path.starts_with(material) || material.starts_with(path))
        }) {
            return Err(
                "A successful result, live R library or namespace still references this material"
                    .into(),
            );
        }
        Ok(())
    }
    fn protect_values(&mut self, paths: &Value, limit: usize) -> Result<(), String> {
        let paths = paths
            .as_array()
            .filter(|paths| paths.len() <= limit)
            .ok_or("R reference paths are missing or exceed their bound")?;
        for path in paths {
            self.protect(path.as_str().ok_or("R reference path is not text")?)?;
        }
        Ok(())
    }
}

impl Owner {
    async fn reference_query(
        &self,
        call: &PluginCall,
        capability: &str,
        arguments: Value,
        partial: bool,
    ) -> Result<Value, String> {
        data(
            self.reads
                .query(call.request.clone(), capability, arguments)
                .await?,
            partial,
        )
    }
    async fn reference_coverage(&self, call: &PluginCall) -> Result<(), String> {
        for id in ["operation.project_coverage", "plugins.project_coverage"] {
            let coverage: ProjectReadCoverage =
                serde_json::from_value(self.reference_query(call, id, json!({}), false).await?)
                    .map_err(error)?;
            if !coverage.all_visible {
                return Err(
                    "Some project references are outside this principal's visible scope".into(),
                );
            }
        }
        Ok(())
    }
    async fn reference_checkpoint(&self, call: &PluginCall) -> Result<u64, String> {
        self.reference_query(call, "operation.events_checkpoint", json!({}), false)
            .await?["sequence"]
            .as_u64()
            .ok_or_else(|| "Journal observation position is unavailable".into())
    }
    async fn reference_instances(
        &self,
        call: &PluginCall,
    ) -> Result<Vec<PluginInstanceObservation>, String> {
        let mut result = Vec::new();
        let mut after = None::<PluginInstanceId>;
        let mut total = None;
        for _ in 0..PAGES {
            let page: PluginInstanceObservations = serde_json::from_value(
                self.reference_query(
                    call,
                    "plugins.instances",
                    json!({"after":after,"limit":PAGE}),
                    true,
                )
                .await?,
            )
            .map_err(error)?;
            if page.instances.len() > PAGE as usize || page.total > (PAGES * PAGE as usize) as u64 {
                return Err("Instance reference inventory exceeded its bound".into());
            }
            if total.is_some_and(|total| total != page.total) {
                return Err("Instance reference count changed between pages".into());
            }
            total = Some(page.total);
            for observation in &page.instances {
                let instance = &observation.instance;
                if instance.project != call.binding.project
                    || instance.principal != call.principal
                    || after
                        .as_ref()
                        .is_some_and(|after| instance.identity.instance <= *after)
                    || result.iter().any(|old: &PluginInstanceObservation| {
                        old.instance.identity.instance == instance.identity.instance
                    })
                {
                    return Err("Instance reference inventory changed scope or cursor".into());
                }
            }
            if let Some(next) = &page.next {
                if page
                    .instances
                    .last()
                    .is_none_or(|last| last.instance.identity.instance != *next)
                {
                    return Err("Instance reference inventory did not advance".into());
                }
            }
            result.extend(page.instances);
            after = page.next;
            if after.is_none() {
                if result.len() as u64 != page.total {
                    return Err(
                        "Instance reference inventory ended before its declared count".into(),
                    );
                }
                return Ok(result);
            }
        }
        Err("Instance reference inventory exceeded its page bound".into())
    }
    async fn operation_references(
        &self,
        call: &PluginCall,
        references: &mut References,
        inspected_cleanup: Option<&OperationId>,
    ) -> Result<(), String> {
        let mut before = None::<u64>;
        let mut seen = BTreeSet::new();
        for _ in 0..PAGES {
            let page = self
                .reference_query(
                    call,
                    "operation.list_recent",
                    json!({"before_cursor":before,"limit":PAGE}),
                    true,
                )
                .await?;
            let operations = page["operations"]
                .as_array()
                .filter(|items| items.len() <= PAGE as usize)
                .ok_or("Invalid operation reference page")?;
            let mut last = before;
            for summary in operations {
                let cursor = summary["cursor"]
                    .as_u64()
                    .ok_or("Missing operation reference cursor")?;
                if cursor == 0
                    || cursor > i64::MAX as u64
                    || last.is_some_and(|previous| cursor >= previous)
                {
                    return Err("Operation reference cursor did not advance".into());
                }
                last = Some(cursor);
                let id = OperationId::new(
                    summary["operation_id"]
                        .as_str()
                        .ok_or("Missing operation reference identity")?,
                )
                .map_err(error)?;
                if !seen.insert(id.clone()) {
                    return Err("Operation reference inventory repeated an identity".into());
                }
                if call.operation_id.as_deref() == Some(id.as_str())
                    || inspected_cleanup == Some(&id)
                {
                    continue;
                }
                let capability: CapabilityKey =
                    serde_json::from_value(summary["capability"].clone()).map_err(error)?;
                let name = capability.id.as_str();
                let status = summary["status"]
                    .as_str()
                    .ok_or("Missing reference outcome")?;
                if name.starts_with("workspace.") || name.starts_with("runtime.") {
                    return Err("Recorded scientific work has no ordinary-plugin reference contract; its references remain unknown".into());
                }
                if !(name.starts_with("environment.") || name.starts_with("r.")) {
                    continue;
                }
                if !matches!(status, "succeeded" | "failed" | "cancelled") {
                    return Err("Live or uncertain scientific work still needs its original recovery references".into());
                }
                let known_r = match name {
                    "r.create_session" | "r.execute" => matches!(capability.version, 1 | 2),
                    "r.format" => capability.version == 1,
                    _ => false,
                };
                if name.starts_with("r.") && !known_r {
                    return Err("An R recovery or operation reference is not yet understood; material is retained".into());
                }
                if name.starts_with("environment.")
                    && (capability.version != 2
                        || !matches!(
                            name,
                            source::PLAN
                                | source::REALIZE
                                | source::VERIFY
                                | source::REFRESH
                                | source::RECONCILE
                                | source::CLEANUP
                                | source::RESTORE
                                | source::PURGE
                        ))
                {
                    return Err(
                        "An Environment operation has an unsupported reference contract".into(),
                    );
                }
                if !matches!(name, source::PLAN | source::REALIZE) || status != "succeeded" {
                    continue;
                }
                if capability.version != 2 {
                    return Err(
                        "An Environment result has an unsupported reference contract".into(),
                    );
                }
                let record = self
                    .reference_query(call, "operation.get", json!({"operation_id":id}), false)
                    .await?["record"]
                    .clone();
                let operation = &record["operation"];
                let binding: ProviderBinding =
                    serde_json::from_value(operation["normalized_arguments"]["binding"].clone())
                        .map_err(error)?;
                let report: EnvironmentResult =
                    serde_json::from_value(record["output"].clone()).map_err(error)?;
                if record["status"] != "succeeded"
                    || operation["operation_id"] != id.as_str()
                    || operation["idempotency_scope"] != self.root
                    || binding.project != call.binding.project
                    || binding.capability != capability
                    || operation["capability"] != json!(capability)
                    || operation["admission"]["owner_context"]["binding"] != json!(binding)
                    || report.operation != id
                {
                    return Err(
                        "Environment reference differs from its original admitted result".into(),
                    );
                }
                source::validate_report(&report.report, &binding)?;
                let bytes = self.read(call, &report.report).await?;
                if name == source::PLAN {
                    if report.kind != EnvironmentReportKind::Plan {
                        return Err("Invalid plan reference report".into());
                    }
                    let plan: EnvironmentPlan = serde_json::from_slice(&bytes).map_err(error)?;
                    if plan.project_root != self.root {
                        return Err("Plan reference belongs to another project".into());
                    }
                    references.protect(&plan.lock_path)?;
                    for source in plan.local_sources {
                        references.protect(&source.path)?;
                    }
                } else {
                    if report.kind != EnvironmentReportKind::Realization {
                        return Err("Invalid realization reference report".into());
                    }
                    let realization: EnvironmentRealization =
                        serde_json::from_slice(&bytes).map_err(error)?;
                    if realization.project_root != self.root {
                        return Err("Realization reference belongs to another project".into());
                    }
                    references.protect(&realization.library_path)?;
                    references.protect(&realization.renv_lockfile)?;
                }
            }
            before = match &page["next_cursor"] {
                Value::Null => None,
                value => Some(value.as_u64().ok_or("Invalid operation reference cursor")?),
            };
            if before.is_none() {
                return Ok(());
            }
            if operations.is_empty() || before != last {
                return Err("Operation reference continuation did not advance".into());
            }
        }
        Err("Operation reference inventory exceeded its page bound".into())
    }
    async fn r_references(
        &self,
        call: &PluginCall,
        instances: &[PluginInstanceObservation],
        references: &mut References,
    ) -> Result<(), String> {
        for observed in instances {
            let instance = &observed.instance;
            let inspected: PluginInspection = serde_json::from_value(
                self.reference_query(
                    call,
                    "plugins.inspect",
                    json!({"revision":instance.identity.revision}),
                    false,
                )
                .await?,
            )
            .map_err(error)?;
            if inspected.summary.revision != instance.identity.revision
                || inspected.manifest.id != instance.identity.plugin
            {
                return Err("Instance reference manifest changed identity".into());
            }
            let capabilities = &inspected.manifest.capabilities;
            if !capabilities
                .iter()
                .any(|c| c.capability.id.as_str().starts_with("r."))
            {
                continue;
            }
            if instance.state == InstanceState::Released {
                continue;
            }
            if instance.state != InstanceState::Active || !observed.observed_in_this_host {
                return Err(
                    "An R provider is unavailable; native library references remain unknown".into(),
                );
            }
            for name in ["r.session", "r.snapshot"] {
                if !capabilities.iter().any(|c| {
                    c.capability.id.as_str() == name
                        && c.capability.version == 1
                        && c.kind == CapabilityKind::Query
                }) {
                    return Err(
                        "An R provider lacks the supported read-only library observation contract"
                            .into(),
                    );
                }
            }
            let binding = |name: &str, target: Option<String>| ProviderBinding {
                capability: CapabilityKey {
                    id: ContributionId::new(name).unwrap(),
                    version: 1,
                },
                provider: instance.identity.clone(),
                project: call.binding.project.clone(),
                target,
            };
            let session = self
                .reference_query(
                    call,
                    "r.session",
                    json!({"binding":binding("r.session",None),"arguments":{}}),
                    false,
                )
                .await?;
            if session["state"] == "unstarted"
                && session["session_id"].is_null()
                && session["launch_operation"].is_null()
            {
                continue;
            }
            let target = session["session_id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("R session creation or shutdown is unconfirmed")?;
            if session["state"] != "idle" || session["queue_target"] != target {
                return Err("R is not idle at an exact native session".into());
            }
            if !session["environment"].is_null() {
                references.protect(
                    session["environment"]["library_path"]
                        .as_str()
                        .ok_or("Selected R Environment reference is incomplete")?,
                )?;
            }
            let snapshot = self.reference_query(call, "r.snapshot", json!({"binding":binding("r.snapshot",Some(target.into())),"arguments":{"expected_session":target,"limit":1}}), true).await?;
            if snapshot["session_id"] != target
                || snapshot["data"]["library_usage_complete"] != true
            {
                return Err(
                    "R library and namespace observation is incomplete or changed session".into(),
                );
            }
            references.protect_values(&snapshot["data"]["library_paths"], 128)?;
            references.protect_values(&snapshot["data"]["namespace_paths"], 512)?;
            let current = self
                .reference_query(
                    call,
                    "r.session",
                    json!({"binding":binding("r.session",Some(target.into())),"arguments":{}}),
                    false,
                )
                .await?;
            if current["session_id"] != target
                || current["state"] != "idle"
                || current["environment"] != session["environment"]
            {
                return Err("R session changed while observing material references".into());
            }
        }
        Ok(())
    }

    pub(super) async fn check_material_references(
        &self,
        call: &PluginCall,
        paths: &[String],
        inspected_cleanup: Option<&OperationId>,
    ) -> Result<(), String> {
        let scan = async {
            self.reference_coverage(call).await?;
            let checkpoint = self.reference_checkpoint(call).await?;
            let instances = self.reference_instances(call).await?;
            let mut references = References::new(paths)?;
            self.operation_references(call, &mut references, inspected_cleanup)
                .await?;
            self.r_references(call, &instances, &mut references).await?;
            let current = self.reference_instances(call).await?;
            let identity = |observed: &PluginInstanceObservation| {
                (
                    observed.instance.clone(),
                    observed.observed_in_this_host,
                    observed.process_id,
                )
            };
            if instances.iter().map(identity).collect::<Vec<_>>()
                != current.iter().map(identity).collect::<Vec<_>>()
            {
                return Err("Plugin instances changed while observing material references".into());
            }
            self.reference_coverage(call).await?;
            if self.reference_checkpoint(call).await? != checkpoint {
                return Err(
                    "Original operation records changed while observing material references".into(),
                );
            }
            Ok(())
        };
        tokio::time::timeout(Duration::from_secs(30), scan)
            .await
            .map_err(|_| "Material reference observation exceeded its deadline")?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[tokio::test]
    async fn reference_scans_preserve_unknown_recovery_and_exact_native_usage() {
        for (scenario, reason) in [
            ("empty", None),
            ("idle", None),
            ("released", None),
            ("execute_v2", None),
            ("unstarted", None),
            ("foreign", Some("outside")),
            ("grant", Some("not granted")),
            ("count", Some("declared count")),
            ("journal", Some("records changed")),
            ("instances", Some("instances changed")),
            ("busy", Some("not idle")),
            ("session", Some("session changed")),
            ("partial", Some("incomplete")),
            ("namespace", Some("still references")),
            ("selected", Some("still references")),
            ("plan", Some("still references")),
            ("checkpoint", Some("not yet understood")),
            ("unknown_r_version", Some("not yet understood")),
            (
                "unknown_environment",
                Some("unsupported reference contract"),
            ),
            ("native_owner", Some("no ordinary-plugin")),
            ("disconnected", Some("provider is unavailable")),
            ("uncertain", Some("uncertain scientific")),
        ] {
            let (directory, owner, mut requests) = crate::tests::fixture(true);
            let root = directory.path().canonicalize().unwrap();
            let material = root
                .join("materials/original-stage")
                .to_str()
                .unwrap()
                .to_owned();
            let query =
                crate::tests::query(source::RETENTION, json!({"operation_id":"material-source"}));
            let mut identity = crate::tests::identity();
            identity.plugin = PluginId::new("fixture.r").unwrap();
            identity.instance = PluginInstanceId::new("r-instance").unwrap();
            let instance = PluginInstanceObservation {
                instance: PluginInstance {
                    identity: identity.clone(),
                    project: query.binding.project.clone(),
                    principal: query.principal.clone(),
                    alias: InstanceAlias::new("r").unwrap(),
                    configuration: json!({}),
                    state: if scenario == "released" {
                        InstanceState::Released
                    } else if scenario == "disconnected" {
                        InstanceState::Disconnected
                    } else {
                        InstanceState::Active
                    },
                    diagnostic: None,
                },
                observed_in_this_host: true,
                process_id: Some(42),
                retained_calls: None,
                pending_messages: None,
                stderr: None,
            };
            let mut manifest = crate::manifest::manifest();
            manifest.id = identity.plugin.clone();
            let mut session = manifest
                .capabilities
                .iter()
                .find(|c| c.capability.id.as_str() == source::STATUS)
                .unwrap()
                .clone();
            session.capability.id = ContributionId::new("r.session").unwrap();
            let mut snapshot = session.clone();
            snapshot.capability.id = ContributionId::new("r.snapshot").unwrap();
            manifest.capabilities = vec![session, snapshot];
            let inspected = json!(PluginInspection {
                summary: PluginCatalogItem {
                    revision: identity.revision.clone(),
                    plugin: identity.plugin.clone(),
                    name: "R fixture".into(),
                    version: "1".into(),
                    description: "fixture".into(),
                    artifacts: vec![identity.artifact.clone()],
                    reference_count: 1
                },
                manifest,
                parent: None,
                source_file_count: 1,
                artifacts: vec![]
            });
            let mut plan = crate::tests::original(&owner).await;
            let report = serde_json::to_vec(&json!(EnvironmentPlan {
                project_root: root.to_str().unwrap().into(),
                manager: "pak".into(),
                lock_path: root.join("another/lock.json").to_str().unwrap().into(),
                lock_digest: "unused".into(),
                r_version: "4.5".into(),
                platform: "fixture".into(),
                packages: vec![],
                local_sources: vec![SourceDigest {
                    path: format!("{material}/package"),
                    sha256: "unused".into()
                }]
            }))
            .unwrap();
            let reference = &mut plan["data"]["record"]["output"]["report"];
            reference["bytes"] = json!(report.len());
            reference["digest"] = json!(format!("sha256:{:x}", Sha256::digest(&report)));
            let material_path = material.clone();
            let responder = tokio::spawn(async move {
                let mut checkpoints = 0;
                let mut listings = 0;
                let mut sessions = 0;
                while let Some(request) = requests.recv().await {
                    let id = request.capability.id.as_str();
                    if scenario == "grant" && id == "operation.project_coverage" {
                        let _ = request
                            .reply
                            .send(Err("Reference grant was not granted".into()));
                        continue;
                    }
                    let (value, partial) = match id {
                        "operation.project_coverage" | "plugins.project_coverage" => {
                            (json!({"all_visible":scenario!="foreign"}), false)
                        }
                        "operation.events_checkpoint" => {
                            checkpoints += 1;
                            (
                                json!({"sequence":if scenario=="journal" && checkpoints>1 {2}else{1}}),
                                false,
                            )
                        }
                        "plugins.instances" => {
                            listings += 1;
                            let has_r = matches!(
                                scenario,
                                "idle"
                                    | "released"
                                    | "unstarted"
                                    | "busy"
                                    | "session"
                                    | "partial"
                                    | "namespace"
                                    | "selected"
                                    | "disconnected"
                            ) || scenario == "instances" && listings > 1;
                            (
                                json!({"instances":if has_r {vec![json!(instance)]}else{vec![]},"next":null,"total":if has_r || scenario=="count" {1}else{0}}),
                                true,
                            )
                        }
                        "plugins.inspect" => (inspected.clone(), false),
                        "operation.list_recent" => {
                            let (capability, status) = match scenario {
                                "plan" => (source::PLAN, "succeeded"),
                                "checkpoint" => ("r.capture_checkpoint", "succeeded"),
                                "unknown_r_version" | "execute_v2" => ("r.execute", "succeeded"),
                                "unknown_environment" => ("environment.capture", "succeeded"),
                                "native_owner" => ("workspace.run_r", "succeeded"),
                                "uncertain" => ("r.execute", "uncertain"),
                                _ => ("", ""),
                            };
                            (
                                json!({"operations":if capability.is_empty(){vec![]}else{vec![json!({"cursor":1,"operation_id":"original-plan","capability":{"id":capability,"version":if scenario=="unknown_r_version" {3}else{2}},"status":status})]},"next_cursor":null}),
                                true,
                            )
                        }
                        "operation.get" => {
                            let _ = request.reply.send(Ok(plan.clone()));
                            continue;
                        }
                        "resources.read" => (
                            json!({"reference":request.arguments["reference"],"offset":0,"next":null,"base64":base64::engine::general_purpose::STANDARD.encode(&report)}),
                            false,
                        ),
                        "r.session" => {
                            sessions += 1;
                            if scenario == "unstarted" {
                                (
                                    json!({"state":"unstarted","session_id":null,"launch_operation":null}),
                                    false,
                                )
                            } else {
                                (
                                    json!({"state":if scenario=="busy" {"busy"}else{"idle"},"session_id":if scenario=="session" && sessions>1 {"replacement"}else{"native-session"},"queue_target":"native-session","environment":if scenario=="selected" {json!({"library_path":material_path})}else{Value::Null}}),
                                    false,
                                )
                            }
                        }
                        "r.snapshot" => {
                            assert_eq!(
                                request.arguments["arguments"]["expected_session"],
                                "native-session"
                            );
                            (
                                json!({"session_id":"native-session","data":{"library_usage_complete":scenario!="partial","library_paths":[],"namespace_paths":if scenario=="namespace"{vec![format!("{material_path}/package")]}else{vec![]}}}),
                                true,
                            )
                        }
                        _ => panic!("Unexpected reference query {id}"),
                    };
                    let _=request.reply.send(Ok(json!({"status":"ready","completeness":if partial {"partial"}else{"complete"},"data":value})));
                }
            });
            let result = owner
                .check_material_references(&query, &[material], None)
                .await;
            responder.abort();
            let _ = responder.await;
            if let Some(reason) = reason {
                assert!(result.unwrap_err().contains(reason), "{scenario}");
            } else {
                assert!(result.is_ok(), "{scenario}: {result:?}");
            }
            assert_eq!(
                std::fs::read(root.join("Rscript")).unwrap(),
                b"must never execute in these tests"
            );
            assert!(
                !root.join("materials/recovery").exists(),
                "Reference observations must not start native R"
            );
        }
    }

    #[test]
    fn original_quarantined_paths_and_aliases_remain_protected() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let stage = root.join("stage");
        std::fs::create_dir(&stage).unwrap();
        let mut references = References::new(&[
            stage.to_str().unwrap().into(),
            root.join("trash").to_str().unwrap().into(),
        ])
        .unwrap();
        assert!(
            references
                .protect(stage.join("library/pkg").to_str().unwrap())
                .is_err()
        );
        assert!(
            references
                .protect(root.join("stage-neighbor/library").to_str().unwrap())
                .is_ok()
        );
        #[cfg(unix)]
        {
            let alias = root.join("alias");
            std::os::unix::fs::symlink(&stage, &alias).unwrap();
            assert!(
                references
                    .protect(alias.join("package").to_str().unwrap())
                    .is_err()
            );
        }
        std::fs::rename(&stage, root.join("trash")).unwrap();
        assert!(
            references
                .protect(stage.join("library/pkg").to_str().unwrap())
                .is_err()
        );
        assert!(references.protect(root.to_str().unwrap()).is_err());
    }
}
