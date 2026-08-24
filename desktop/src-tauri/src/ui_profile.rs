use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};

#[cfg(test)]
use anyhow::anyhow;
use anyhow::{Context, Result, ensure};
use rho_ui_contract::{
    BlockId, LayoutAxisV1, LayoutBasisV1, LayoutChildV1, LayoutNodeId, LayoutNodeV1,
    PROJECT_UI_PROFILE_SCHEMA_VERSION, PROJECT_UI_PROFILE_SNAPSHOT_CONTRACT, PageId, ProjectId,
    ProjectUiProfileSnapshotV1, ProjectUiProfileV1, RSR_CONTRACT_MAJOR, RuntimeAttachmentIntentV1,
    RuntimeRegistrySnapshotV1, SceneId, ScenePresetId, SceneStateV1, SectionId, StackNodeV1,
    StudioScenePresetV1, SurfaceFactoryRegistrationV1, SurfaceInstanceSpecV1,
    SurfaceLifecycleStateV1, SurfaceRuntimeSnapshotV1, UiProfileLoadStatusV1, UiProfileModeV1,
    UiProfileMutationV1, UiProfileRevisionRequestV1, Validate, VibeBlockContentV1, VibeBlockV1,
    VibePageExportV1, VibePageMutationV1, VibePageV1, VibeRichTextDocumentV1, VibeSectionLayoutV1,
    VibeSectionV1, apply_ui_profile_mutation, apply_vibe_page_mutation, export_vibe_page,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::project::{atomic_write, display_path, stable_project_key};
use crate::{AppState, display_error};

pub(crate) const UI_PROFILE_CHANGED_EVENT: &str = "rho://ui-profile-changed";
const MAX_STORED_PROFILE_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredProjectUiProfileV1 {
    normalized_project_root: String,
    profile: ProjectUiProfileV1,
}

#[derive(Debug, Clone)]
struct LoadedProfile {
    profile: ProjectUiProfileV1,
    status: UiProfileLoadStatusV1,
    recovery_detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileStoreFailurePoint {
    BeforeBackup,
    BeforeMainReplace,
}

#[derive(Clone)]
pub(crate) struct ProjectUiProfileStore {
    profiles_dir: PathBuf,
    operation_gate: Arc<StdMutex<()>>,
    #[cfg(test)]
    failure: Arc<StdMutex<Option<ProfileStoreFailurePoint>>>,
}

impl ProjectUiProfileStore {
    pub(crate) fn new(data_dir: PathBuf) -> Result<Self> {
        let profiles_dir = data_dir.join("project-sessions").join("ui-profiles");
        std::fs::create_dir_all(&profiles_dir)?;
        Ok(Self {
            profiles_dir,
            operation_gate: Arc::new(StdMutex::new(())),
            #[cfg(test)]
            failure: Arc::new(StdMutex::new(None)),
        })
    }

    fn gate(&self) -> MutexGuard<'_, ()> {
        self.operation_gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn path(&self, root: &Path) -> PathBuf {
        self.profiles_dir
            .join(format!("{}.json", stable_project_key(root)))
    }

    fn backup_path(&self, root: &Path) -> PathBuf {
        self.profiles_dir
            .join(format!("{}.backup.json", stable_project_key(root)))
    }

    fn obsolete_path(&self, root: &Path, schema_version: u64) -> PathBuf {
        self.profiles_dir.join(format!(
            "{}.schema-{schema_version}.obsolete.json",
            stable_project_key(root)
        ))
    }

    fn normalized_root(root: &Path) -> String {
        display_path(root)
    }

    fn read_bytes(path: &Path) -> Result<Vec<u8>> {
        let metadata = path.metadata()?;
        ensure!(
            metadata.is_file() && metadata.len() <= MAX_STORED_PROFILE_FILE_BYTES,
            "Project UI Profile file is not a bounded regular file"
        );
        std::fs::read(path).with_context(|| format!("reading {}", path.display()))
    }

    fn decode(bytes: &[u8], root: &Path, project_id: &ProjectId) -> Result<ProjectUiProfileV1> {
        let stored: StoredProjectUiProfileV1 =
            serde_json::from_slice(bytes).context("parsing the stored Project UI Profile")?;
        ensure!(
            stored.normalized_project_root == Self::normalized_root(root),
            "Project UI Profile belongs to another project root"
        );
        ensure!(
            &stored.profile.project_id == project_id,
            "Project UI Profile belongs to another project identity"
        );
        stored.profile.validate()?;
        Ok(stored.profile)
    }

    fn encode(root: &Path, profile: &ProjectUiProfileV1) -> Result<Vec<u8>> {
        profile.validate()?;
        let bytes = serde_json::to_vec_pretty(&StoredProjectUiProfileV1 {
            normalized_project_root: Self::normalized_root(root),
            profile: profile.clone(),
        })?;
        ensure!(
            bytes.len() as u64 <= MAX_STORED_PROFILE_FILE_BYTES,
            "Project UI Profile file exceeds its storage budget"
        );
        Ok(bytes)
    }

    fn obsolete_owned_schema(bytes: &[u8], root: &Path, project_id: &ProjectId) -> Option<u64> {
        let value = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
        let stored_root = value.get("normalized_project_root")?.as_str()?;
        let profile = value.get("profile")?;
        let stored_project = profile.get("project_id")?.as_str()?;
        let schema_version = profile.get("schema_version")?.as_u64()?;
        (stored_root == Self::normalized_root(root)
            && stored_project == project_id.as_str()
            && schema_version < u64::from(PROJECT_UI_PROFILE_SCHEMA_VERSION))
        .then_some(schema_version)
    }

    fn load_or_create(
        &self,
        root: &Path,
        project_id: &ProjectId,
        create: impl FnOnce() -> Result<ProjectUiProfileV1>,
    ) -> Result<LoadedProfile> {
        let _gate = self.gate();
        let path = self.path(root);
        let backup = self.backup_path(root);
        if path.is_file() {
            let main_bytes = Self::read_bytes(&path)?;
            if let Some(schema_version) = Self::obsolete_owned_schema(&main_bytes, root, project_id)
            {
                let profile = create()?;
                ensure!(
                    &profile.project_id == project_id,
                    "Replacement Project UI Profile belongs to another project"
                );
                let bytes = Self::encode(root, &profile)?;
                atomic_write(&self.obsolete_path(root, schema_version), &main_bytes)
                    .context("archiving the obsolete unshipped Project UI Profile")?;
                atomic_write(&backup, &bytes)
                    .context("seeding the replacement Project UI Profile backup")?;
                atomic_write(&path, &bytes)
                    .context("replacing the obsolete unshipped Project UI Profile")?;
                return Ok(LoadedProfile {
                    profile,
                    status: UiProfileLoadStatusV1::Created,
                    recovery_detail: Some(format!(
                        "Rebuilt the unshipped UI Profile schema {schema_version} as schema {}. The obsolete file was archived locally.",
                        PROJECT_UI_PROFILE_SCHEMA_VERSION
                    )),
                });
            }
            match Self::decode(&main_bytes, root, project_id) {
                Ok(profile) => {
                    return Ok(LoadedProfile {
                        profile,
                        status: UiProfileLoadStatusV1::Clean,
                        recovery_detail: None,
                    });
                }
                Err(main_error) if backup.is_file() => {
                    let backup_bytes = Self::read_bytes(&backup)?;
                    let profile = Self::decode(&backup_bytes, root, project_id)
                        .context("Project UI Profile backup is also invalid")?;
                    atomic_write(&path, &backup_bytes)
                        .context("restoring the Project UI Profile backup")?;
                    return Ok(LoadedProfile {
                        profile,
                        status: UiProfileLoadStatusV1::RecoveredBackup,
                        recovery_detail: Some(format!(
                            "Recovered the last valid UI Profile after the main file failed validation: {main_error}"
                        )),
                    });
                }
                Err(error) => {
                    return Err(error.context(
                        "Project UI Profile is invalid and no valid recovery backup exists",
                    ));
                }
            }
        }
        if backup.is_file() {
            let backup_bytes = Self::read_bytes(&backup)?;
            let profile = Self::decode(&backup_bytes, root, project_id)?;
            atomic_write(&path, &backup_bytes)?;
            return Ok(LoadedProfile {
                profile,
                status: UiProfileLoadStatusV1::RecoveredBackup,
                recovery_detail: Some(
                    "Recovered the UI Profile because its main file was missing.".to_string(),
                ),
            });
        }
        let profile = create()?;
        ensure!(
            &profile.project_id == project_id,
            "New Project UI Profile belongs to another project"
        );
        let bytes = Self::encode(root, &profile)?;
        atomic_write(&path, &bytes)?;
        Ok(LoadedProfile {
            profile,
            status: UiProfileLoadStatusV1::Created,
            recovery_detail: None,
        })
    }

    fn save(
        &self,
        root: &Path,
        expected_revision: u64,
        profile: &ProjectUiProfileV1,
    ) -> Result<()> {
        let _gate = self.gate();
        let path = self.path(root);
        let backup = self.backup_path(root);
        let current_bytes = Self::read_bytes(&path)?;
        let current = Self::decode(&current_bytes, root, &profile.project_id)?;
        ensure!(
            current.revision == expected_revision,
            "Project UI Profile revision is stale"
        );
        ensure!(
            profile.revision == expected_revision + 1,
            "Project UI Profile candidate revision is not the next revision"
        );
        let candidate = Self::encode(root, profile)?;
        self.maybe_fail(ProfileStoreFailurePoint::BeforeBackup)?;
        atomic_write(&backup, &current_bytes).context("writing Project UI Profile backup")?;
        self.maybe_fail(ProfileStoreFailurePoint::BeforeMainReplace)?;
        atomic_write(&path, &candidate).context("replacing Project UI Profile")
    }

    #[cfg(test)]
    fn inject_failure(&self, point: ProfileStoreFailurePoint) {
        *self.failure.lock().unwrap() = Some(point);
    }

    fn maybe_fail(&self, point: ProfileStoreFailurePoint) -> Result<()> {
        #[cfg(test)]
        {
            let mut failure = self.failure.lock().unwrap();
            if *failure == Some(point) {
                failure.take();
                return Err(anyhow!(
                    "injected Project UI Profile store failure at {point:?}"
                ));
            }
        }
        let _ = point;
        Ok(())
    }
}

#[derive(Clone)]
struct CurrentProfile {
    root: PathBuf,
    snapshot: ProjectUiProfileSnapshotV1,
}

pub(crate) struct ProjectUiProfileState {
    store: ProjectUiProfileStore,
    current: StdMutex<Option<CurrentProfile>>,
}

impl ProjectUiProfileState {
    pub(crate) fn new(data_dir: PathBuf) -> Result<Self> {
        Ok(Self {
            store: ProjectUiProfileStore::new(data_dir)?,
            current: StdMutex::new(None),
        })
    }

    fn inner(&self) -> MutexGuard<'_, Option<CurrentProfile>> {
        self.current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn snapshot_for(
        profile: ProjectUiProfileV1,
        status: UiProfileLoadStatusV1,
        recovery_detail: Option<String>,
        presets: Vec<StudioScenePresetV1>,
    ) -> Result<ProjectUiProfileSnapshotV1> {
        let snapshot = ProjectUiProfileSnapshotV1 {
            contract: PROJECT_UI_PROFILE_SNAPSHOT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            profile,
            immutable_scene_presets: presets,
            load_status: status,
            recovery_detail,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    fn reconcile(
        &self,
        root: PathBuf,
        project_id: ProjectId,
        factories: &[SurfaceFactoryRegistrationV1],
        runtimes: &RuntimeRegistrySnapshotV1,
    ) -> Result<ProjectUiProfileSnapshotV1> {
        let mut current = self.inner();
        if let Some(existing) = current.as_ref()
            && existing.root == root
            && existing.snapshot.profile.project_id == project_id
        {
            return Ok(existing.snapshot.clone());
        }
        let seed = default_profile_seed(&project_id, factories, runtimes)?;
        let immutable = rho_studio_preset(&project_id, &seed.surface_instance_specs)?;
        let loaded = self.store.load_or_create(&root, &project_id, || Ok(seed))?;
        let snapshot = Self::snapshot_for(
            loaded.profile,
            loaded.status,
            loaded.recovery_detail,
            vec![immutable],
        )?;
        *current = Some(CurrentProfile {
            root,
            snapshot: snapshot.clone(),
        });
        Ok(snapshot)
    }

    pub(crate) fn snapshot(&self) -> Result<ProjectUiProfileSnapshotV1> {
        self.inner()
            .as_ref()
            .map(|current| current.snapshot.clone())
            .context("Project UI Profile has not been reconciled")
    }

    fn mutate(
        &self,
        request: &UiProfileRevisionRequestV1,
        mutation: UiProfileMutationV1,
    ) -> Result<ProjectUiProfileSnapshotV1> {
        request.validate()?;
        let mut current = self.inner();
        let active = current
            .as_ref()
            .context("Project UI Profile has not been reconciled")?
            .clone();
        ensure!(
            active.snapshot.profile.project_id == request.project_id,
            "Project UI Profile request belongs to another project"
        );
        let candidate = apply_ui_profile_mutation(
            &active.snapshot.profile,
            request.expected_profile_revision,
            mutation,
        )?;
        self.store
            .save(&active.root, request.expected_profile_revision, &candidate)?;
        let snapshot = Self::snapshot_for(
            candidate,
            UiProfileLoadStatusV1::Clean,
            None,
            active.snapshot.immutable_scene_presets,
        )?;
        *current = Some(CurrentProfile {
            root: active.root,
            snapshot: snapshot.clone(),
        });
        Ok(snapshot)
    }

    fn commit_runtime_state(
        &self,
        scene: Option<SceneStateV1>,
        surfaces: &SurfaceRuntimeSnapshotV1,
    ) -> Result<ProjectUiProfileSnapshotV1> {
        let snapshot = self.snapshot()?;
        ensure!(
            snapshot.profile.project_id == surfaces.project_id,
            "Surface Runtime belongs to another UI Profile"
        );
        let specs = surface_specs(&snapshot.profile, surfaces);
        let focus = scene
            .as_ref()
            .and_then(|scene| scene.focused_surface_instance_id.clone())
            .or_else(|| snapshot.profile.last_focused_surface_instance_id.clone())
            .filter(|focused| specs.iter().any(|spec| spec.instance_id == *focused));
        self.mutate(
            &UiProfileRevisionRequestV1 {
                project_id: snapshot.profile.project_id,
                expected_profile_revision: snapshot.profile.revision,
            },
            UiProfileMutationV1::CommitRuntimeState {
                active_scene: scene,
                surface_instance_specs: specs,
                last_focused_surface_instance_id: focus,
            },
        )
    }
}

fn next_instance_id() -> rho_ui_contract::SurfaceInstanceId {
    rho_ui_contract::SurfaceInstanceId::new(format!("surface-instance:{}", Uuid::new_v4().simple()))
        .expect("host-generated Surface instance ID must be valid")
}

fn next_scene_id() -> SceneId {
    SceneId::new(format!("studio-scene:{}", Uuid::new_v4().simple()))
        .expect("host-generated Scene ID must be valid")
}

fn next_node_id() -> LayoutNodeId {
    LayoutNodeId::new(format!("layout-node:{}", Uuid::new_v4().simple()))
        .expect("host-generated layout node ID must be valid")
}

fn next_page_id() -> PageId {
    PageId::new(format!("vibe-page:{}", Uuid::new_v4().simple()))
        .expect("host-generated Page ID must be valid")
}

fn next_section_id() -> SectionId {
    SectionId::new(format!("vibe-section:{}", Uuid::new_v4().simple()))
        .expect("host-generated Section ID must be valid")
}

fn next_block_id() -> BlockId {
    BlockId::new(format!("vibe-block:{}", Uuid::new_v4().simple()))
        .expect("host-generated Block ID must be valid")
}

fn default_surface_specs(
    factories: &[SurfaceFactoryRegistrationV1],
    runtimes: &RuntimeRegistrySnapshotV1,
) -> Vec<SurfaceInstanceSpecV1> {
    let mut specs = Vec::new();
    if let Some(factory) = factories
        .iter()
        .find(|factory| factory.definition.surface_id.as_str() == "rho.navigator")
    {
        specs.push(SurfaceInstanceSpecV1 {
            instance_id: next_instance_id(),
            surface_id: factory.definition.surface_id.clone(),
            origin: factory.definition.origin.clone(),
            mode_id: Some(rho_ui_contract::SurfaceModeId::new("files").unwrap()),
            resource_binding: None,
            runtime_attachment_intent: None,
            view_group_id: None,
            view_state: json!({ "tab": "files" }),
        });
    }
    if let Some(factory) = factories
        .iter()
        .find(|factory| factory.definition.surface_id.as_str() == "rho.environment")
    {
        specs.push(SurfaceInstanceSpecV1 {
            instance_id: next_instance_id(),
            surface_id: factory.definition.surface_id.clone(),
            origin: factory.definition.origin.clone(),
            mode_id: Some(rho_ui_contract::SurfaceModeId::new("packages").unwrap()),
            resource_binding: None,
            runtime_attachment_intent: None,
            view_group_id: None,
            view_state: json!({}),
        });
    }
    if let Some(factory) = factories
        .iter()
        .find(|factory| factory.definition.surface_id.as_str() == "rho.status")
    {
        specs.push(SurfaceInstanceSpecV1 {
            instance_id: next_instance_id(),
            surface_id: factory.definition.surface_id.clone(),
            origin: factory.definition.origin.clone(),
            mode_id: None,
            resource_binding: None,
            runtime_attachment_intent: None,
            view_group_id: None,
            view_state: json!({}),
        });
    }
    if let (Some(factory), Some(runtime)) = (
        factories
            .iter()
            .find(|factory| factory.definition.surface_id.as_str() == "rho.console"),
        runtimes
            .instances
            .iter()
            .find(|runtime| runtime.primary_scientific_runtime),
    ) {
        specs.push(SurfaceInstanceSpecV1 {
            instance_id: next_instance_id(),
            surface_id: factory.definition.surface_id.clone(),
            origin: factory.definition.origin.clone(),
            mode_id: None,
            resource_binding: None,
            runtime_attachment_intent: Some(RuntimeAttachmentIntentV1 {
                runtime_provider_id: runtime.runtime_provider_id.clone(),
                runtime_instance_id: runtime.runtime_instance_id.clone(),
                runtime_kind: runtime.runtime_kind.clone(),
            }),
            view_group_id: None,
            view_state: json!({
                "draft": "",
                "history": [],
                "history_cursor": null,
                "filter": "",
                "scroll_top": 0,
                "outputs": []
            }),
        });
    }
    if let Some(factory) = factories
        .iter()
        .find(|factory| factory.definition.surface_id.as_str() == "rho.agent")
    {
        specs.push(SurfaceInstanceSpecV1 {
            instance_id: next_instance_id(),
            surface_id: factory.definition.surface_id.clone(),
            origin: factory.definition.origin.clone(),
            mode_id: Some(rho_ui_contract::SurfaceModeId::new("conversation").unwrap()),
            resource_binding: None,
            runtime_attachment_intent: None,
            view_group_id: None,
            view_state: json!({
                "conversation_id": null,
                "mode": "ask",
                "composer": "",
                "auto_approve": false
            }),
        });
    }
    specs.sort_by(|left, right| left.instance_id.cmp(&right.instance_id));
    specs
}

fn rho_studio_scene(
    project_id: &ProjectId,
    scene_id: SceneId,
    label: &str,
    specs: &[SurfaceInstanceSpecV1],
) -> SceneStateV1 {
    let find = |surface_id: &str| {
        specs
            .iter()
            .find(|spec| spec.surface_id.as_str() == surface_id)
    };
    let navigator = find("rho.navigator");
    let console = find("rho.console");
    let status = find("rho.status");
    let agent = find("rho.agent");
    let environment = find("rho.environment");
    let mut children = Vec::new();
    if let Some(navigator) = navigator {
        children.push(LayoutChildV1 {
            child: LayoutNodeV1::Surface {
                node_id: next_node_id(),
                instance_id: navigator.instance_id.clone(),
            },
            basis: LayoutBasisV1::Minmax {
                min_logical_pixels: 240,
                max_logical_pixels: 340,
                weight: 1,
            },
            resizable: true,
            collapse_priority: Some(30),
        });
    }
    if let Some(console) = console {
        children.push(LayoutChildV1 {
            child: LayoutNodeV1::Surface {
                node_id: next_node_id(),
                instance_id: console.instance_id.clone(),
            },
            basis: LayoutBasisV1::Fraction { weight: 7 },
            resizable: true,
            collapse_priority: None,
        });
    }
    let context_instances = [agent, environment]
        .into_iter()
        .flatten()
        .map(|spec| spec.instance_id.clone())
        .collect::<Vec<_>>();
    if !context_instances.is_empty() {
        children.push(LayoutChildV1 {
            child: LayoutNodeV1::Stack(StackNodeV1 {
                node_id: next_node_id(),
                active_instance_id: agent
                    .or(environment)
                    .map(|spec| spec.instance_id.clone())
                    .expect("context stack members were just collected"),
                instances: context_instances,
            }),
            basis: LayoutBasisV1::Minmax {
                min_logical_pixels: 340,
                max_logical_pixels: 520,
                weight: 2,
            },
            resizable: true,
            collapse_priority: Some(20),
        });
    }
    if children.is_empty() {
        if let Some(status) = status {
            children.push(LayoutChildV1 {
                child: LayoutNodeV1::Surface {
                    node_id: next_node_id(),
                    instance_id: status.instance_id.clone(),
                },
                basis: LayoutBasisV1::Intrinsic,
                resizable: false,
                collapse_priority: None,
            });
        }
    }
    SceneStateV1 {
        scene_id,
        project_id: project_id.clone(),
        label: label.to_string(),
        layout_revision: 1,
        root: LayoutNodeV1::Container {
            node_id: next_node_id(),
            axis: LayoutAxisV1::Horizontal,
            children,
        },
        focused_surface_instance_id: agent.or(console).map(|spec| spec.instance_id.clone()),
        utility_tray: None,
    }
}

fn rho_studio_preset(
    project_id: &ProjectId,
    specs: &[SurfaceInstanceSpecV1],
) -> Result<StudioScenePresetV1> {
    let preset = StudioScenePresetV1 {
        preset_id: ScenePresetId::new("rho.studio").unwrap(),
        label: "Rho Studio".to_string(),
        description: "A recursive scientific workspace with a primary work area and an intrinsic health strip. Containers remain freely resizable and nestable.".to_string(),
        scene: rho_studio_scene(
            project_id,
            SceneId::new("studio-scene:rho-studio-preset").unwrap(),
            "Rho Studio",
            specs,
        ),
        surface_instance_specs: specs.to_vec(),
    };
    preset.validate()?;
    Ok(preset)
}

fn default_profile_seed(
    project_id: &ProjectId,
    factories: &[SurfaceFactoryRegistrationV1],
    runtimes: &RuntimeRegistrySnapshotV1,
) -> Result<ProjectUiProfileV1> {
    let specs = default_surface_specs(factories, runtimes);
    let scene = rho_studio_scene(project_id, next_scene_id(), "Rho Studio", &specs);
    let page = VibePageV1 {
        page_id: next_page_id(),
        project_id: project_id.clone(),
        label: "Project review".to_string(),
        page_revision: 1,
        sections: vec![VibeSectionV1 {
            section_id: next_section_id(),
            heading: Some("Start with evidence".to_string()),
            layout: VibeSectionLayoutV1::Flow,
            blocks: vec![
                VibeBlockV1 {
                    block_id: next_block_id(),
                    content: VibeBlockContentV1::RichText {
                        document: VibeRichTextDocumentV1::plain_text(
                            "Review this project as a living document. Add narrative, commands, references, and independently placed live Surfaces in any order.",
                        ),
                    },
                },
                VibeBlockV1 {
                    block_id: next_block_id(),
                    content: VibeBlockContentV1::CommandRef {
                        command_id: rho_ui_contract::CommandId::new("rho.check.run").unwrap(),
                        label: "Check project".to_string(),
                    },
                },
            ],
        }],
        focused_block_id: None,
    };
    let profile = ProjectUiProfileV1 {
        schema_version: PROJECT_UI_PROFILE_SCHEMA_VERSION,
        project_id: project_id.clone(),
        revision: 1,
        active_mode: UiProfileModeV1::Studio,
        active_studio_scene_id: Some(scene.scene_id.clone()),
        active_vibe_page_id: Some(page.page_id.clone()),
        studio_scenes: vec![scene.clone()],
        vibe_pages: vec![page],
        surface_instance_specs: specs,
        last_focused_surface_instance_id: scene.focused_surface_instance_id,
    };
    profile.validate()?;
    Ok(profile)
}

fn surface_specs(
    profile: &ProjectUiProfileV1,
    surfaces: &SurfaceRuntimeSnapshotV1,
) -> Vec<SurfaceInstanceSpecV1> {
    let mut specs = surfaces
        .catalog
        .instances
        .iter()
        .map(|instance| {
            let previous = profile
                .surface_instance_specs
                .iter()
                .find(|spec| spec.instance_id == instance.instance_id);
            let runtime_attachment_intent = instance
                .runtime_binding
                .as_ref()
                .map(|binding| RuntimeAttachmentIntentV1 {
                    runtime_provider_id: binding.runtime_provider_id.clone(),
                    runtime_instance_id: binding.runtime_instance_id.clone(),
                    runtime_kind: binding.runtime_kind.clone(),
                })
                .or_else(|| {
                    (instance.lifecycle_state == SurfaceLifecycleStateV1::Placeholder)
                        .then(|| previous.and_then(|spec| spec.runtime_attachment_intent.clone()))
                        .flatten()
                });
            SurfaceInstanceSpecV1 {
                instance_id: instance.instance_id.clone(),
                surface_id: instance.surface_id.clone(),
                origin: instance.origin.clone(),
                mode_id: instance.mode_id.clone(),
                resource_binding: instance.resource_binding.clone(),
                runtime_attachment_intent,
                view_group_id: instance.view_group_id.clone(),
                view_state: instance.view_state.clone(),
            }
        })
        .collect::<Vec<_>>();
    specs.sort_by(|left, right| left.instance_id.cmp(&right.instance_id));
    specs
}

#[derive(Clone, Serialize)]
struct UiProfileChangedEvent<'a> {
    project_id: &'a ProjectId,
    profile_revision: u64,
    active_mode: UiProfileModeV1,
}

pub(crate) fn emit_snapshot(app: &AppHandle, snapshot: &ProjectUiProfileSnapshotV1) {
    let _ = app.emit(
        UI_PROFILE_CHANGED_EVENT,
        UiProfileChangedEvent {
            project_id: &snapshot.profile.project_id,
            profile_revision: snapshot.profile.revision,
            active_mode: snapshot.profile.active_mode,
        },
    );
}

pub(crate) async fn reconcile_for_state(
    state: &AppState,
    factories: &[SurfaceFactoryRegistrationV1],
    runtimes: &RuntimeRegistrySnapshotV1,
) -> Result<ProjectUiProfileSnapshotV1> {
    let kernel = crate::ui_runtime::snapshot_for_state(state).await?;
    let root = state.project_root.read().await.clone();
    state
        .ui_profile
        .reconcile(root, kernel.project.project_id.clone(), factories, runtimes)
}

pub(crate) fn commit_runtime_state(
    state: &AppState,
    scene: Option<SceneStateV1>,
    surfaces: &SurfaceRuntimeSnapshotV1,
) -> Result<ProjectUiProfileSnapshotV1> {
    state.ui_profile.commit_runtime_state(scene, surfaces)
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct SetModeRequest {
    target: UiProfileRevisionRequestV1,
    mode: UiProfileModeV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct SelectSceneRequest {
    target: UiProfileRevisionRequestV1,
    scene_id: SceneId,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct SelectPageRequest {
    target: UiProfileRevisionRequestV1,
    page_id: PageId,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct SceneLabelRequest {
    target: UiProfileRevisionRequestV1,
    scene_id: SceneId,
    label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct SceneTargetRequest {
    target: UiProfileRevisionRequestV1,
    scene_id: SceneId,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct PageMutationRequest {
    target: UiProfileRevisionRequestV1,
    page_id: PageId,
    #[specta(type = rho_ui_contract::UiIpcNumber)]
    expected_page_revision: u64,
    mutation: VibePageMutationV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct PageExportRequest {
    project_id: ProjectId,
    #[specta(type = rho_ui_contract::UiIpcNumber)]
    expected_profile_revision: u64,
    page_id: PageId,
    #[specta(type = rho_ui_contract::UiIpcNumber)]
    expected_page_revision: u64,
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn ui_profile_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectUiProfileSnapshotV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let runtimes = crate::runtime_registry::reconcile_for_state(&state)
        .await
        .map_err(display_error)?;
    let factories = crate::surface_runtime::available_factories(&state)
        .await
        .map_err(display_error)?;
    let snapshot = reconcile_for_state(&state, &factories, &runtimes.snapshot)
        .await
        .map_err(display_error)?;
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

fn mutate_and_emit(
    app: &AppHandle,
    state: &AppState,
    target: &UiProfileRevisionRequestV1,
    mutation: UiProfileMutationV1,
) -> Result<ProjectUiProfileSnapshotV1> {
    let snapshot = state.ui_profile.mutate(target, mutation)?;
    emit_snapshot(app, &snapshot);
    Ok(snapshot)
}

async fn reconcile_studio_after_profile(app: &AppHandle, state: &AppState) -> Result<()> {
    let surface = crate::surface_runtime::reconcile_for_state(state).await?;
    crate::surface_runtime::emit_transition(app, &surface);
    let studio = crate::studio_runtime::reconcile_with_surface_snapshot(state, &surface.snapshot)?;
    crate::studio_runtime::emit_transition(app, &studio);
    Ok(())
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn ui_profile_set_mode(
    request: SetModeRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectUiProfileSnapshotV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let snapshot = mutate_and_emit(
        &app,
        &state,
        &request.target,
        UiProfileMutationV1::SetActiveMode { mode: request.mode },
    )
    .map_err(display_error)?;
    reconcile_studio_after_profile(&app, &state)
        .await
        .map_err(display_error)?;
    Ok(snapshot)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn ui_profile_select_scene(
    request: SelectSceneRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectUiProfileSnapshotV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let snapshot = mutate_and_emit(
        &app,
        &state,
        &request.target,
        UiProfileMutationV1::SelectScene {
            scene_id: request.scene_id,
        },
    )
    .map_err(display_error)?;
    reconcile_studio_after_profile(&app, &state)
        .await
        .map_err(display_error)?;
    Ok(snapshot)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn ui_profile_select_page(
    request: SelectPageRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectUiProfileSnapshotV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let snapshot = mutate_and_emit(
        &app,
        &state,
        &request.target,
        UiProfileMutationV1::SelectPage {
            page_id: request.page_id,
        },
    )
    .map_err(display_error)?;
    reconcile_studio_after_profile(&app, &state)
        .await
        .map_err(display_error)?;
    Ok(snapshot)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn ui_profile_page_apply(
    request: PageMutationRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectUiProfileSnapshotV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let snapshot = state.ui_profile.snapshot().map_err(display_error)?;
    if snapshot.profile.project_id != request.target.project_id {
        return Err("Vibe Page request belongs to another project".to_string());
    }
    let page = snapshot
        .profile
        .vibe_pages
        .iter()
        .find(|page| page.page_id == request.page_id)
        .ok_or_else(|| "Vibe Page was not found".to_string())?;
    let candidate =
        apply_vibe_page_mutation(page, request.expected_page_revision, request.mutation)
            .map_err(display_error)?;
    mutate_and_emit(
        &app,
        &state,
        &request.target,
        UiProfileMutationV1::ReplacePage { page: candidate },
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn ui_profile_page_export(
    request: PageExportRequest,
    state: State<'_, AppState>,
) -> Result<VibePageExportV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let snapshot = state.ui_profile.snapshot().map_err(display_error)?;
    if snapshot.profile.project_id != request.project_id {
        return Err("Vibe Page export belongs to another project".to_string());
    }
    if snapshot.profile.revision != request.expected_profile_revision {
        return Err("Vibe Page export has a stale Profile revision".to_string());
    }
    let page = snapshot
        .profile
        .vibe_pages
        .iter()
        .find(|page| page.page_id == request.page_id)
        .ok_or_else(|| "Vibe Page was not found".to_string())?;
    if page.page_revision != request.expected_page_revision {
        return Err("Vibe Page export has a stale Page revision".to_string());
    }
    export_vibe_page(page).map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn ui_profile_scene_duplicate(
    request: SceneLabelRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectUiProfileSnapshotV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let profile = state.ui_profile.snapshot().map_err(display_error)?;
    let source = profile
        .profile
        .studio_scenes
        .iter()
        .find(|scene| scene.scene_id == request.scene_id)
        .cloned()
        .ok_or_else(|| "Studio Scene was not found".to_string())?;
    let mut scene = source;
    scene.scene_id = next_scene_id();
    scene.label = request.label;
    scene.layout_revision = 1;
    let snapshot = mutate_and_emit(
        &app,
        &state,
        &request.target,
        UiProfileMutationV1::DuplicateScene {
            source_scene_id: request.scene_id,
            scene,
        },
    )
    .map_err(display_error)?;
    reconcile_studio_after_profile(&app, &state)
        .await
        .map_err(display_error)?;
    Ok(snapshot)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn ui_profile_scene_save(
    request: SceneTargetRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectUiProfileSnapshotV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let surface = crate::surface_runtime::reconcile_for_state(&state)
        .await
        .map_err(display_error)?;
    let studio = crate::studio_runtime::reconcile_with_surface_snapshot(&state, &surface.snapshot)
        .map_err(display_error)?;
    if studio.snapshot.scene.scene_id != request.scene_id {
        return Err("Only the active Studio Scene can be saved".to_string());
    }
    mutate_and_emit(
        &app,
        &state,
        &request.target,
        UiProfileMutationV1::ReplaceScene {
            scene: studio.snapshot.scene,
        },
    )
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn ui_profile_scene_rename(
    request: SceneLabelRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectUiProfileSnapshotV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let snapshot = mutate_and_emit(
        &app,
        &state,
        &request.target,
        UiProfileMutationV1::RenameScene {
            scene_id: request.scene_id,
            label: request.label,
        },
    )
    .map_err(display_error)?;
    reconcile_studio_after_profile(&app, &state)
        .await
        .map_err(display_error)?;
    Ok(snapshot)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn ui_profile_scene_delete(
    request: SceneTargetRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectUiProfileSnapshotV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let profile = state.ui_profile.snapshot().map_err(display_error)?;
    let next_active = profile
        .profile
        .studio_scenes
        .iter()
        .find(|scene| scene.scene_id != request.scene_id)
        .map(|scene| scene.scene_id.clone())
        .ok_or_else(|| "The last Studio Scene cannot be deleted; reset it instead".to_string())?;
    let snapshot = mutate_and_emit(
        &app,
        &state,
        &request.target,
        UiProfileMutationV1::DeleteScene {
            scene_id: request.scene_id,
            next_active_scene_id: next_active,
        },
    )
    .map_err(display_error)?;
    reconcile_studio_after_profile(&app, &state)
        .await
        .map_err(display_error)?;
    Ok(snapshot)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn ui_profile_scene_reset(
    request: SceneTargetRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectUiProfileSnapshotV1, String> {
    let _project = state.project_transition_gate.lock().await;
    let profile = state.ui_profile.snapshot().map_err(display_error)?;
    let current = profile
        .profile
        .studio_scenes
        .iter()
        .find(|scene| scene.scene_id == request.scene_id)
        .ok_or_else(|| "Studio Scene was not found".to_string())?;
    let mut replacement = profile
        .immutable_scene_presets
        .first()
        .context("Rho Studio preset is unavailable")
        .map_err(display_error)?
        .scene
        .clone();
    let restore_surface_instance_specs = profile.immutable_scene_presets[0]
        .surface_instance_specs
        .clone();
    replacement.scene_id = current.scene_id.clone();
    replacement.project_id = current.project_id.clone();
    replacement.label = current.label.clone();
    replacement.layout_revision = current.layout_revision.saturating_add(1);
    let snapshot = mutate_and_emit(
        &app,
        &state,
        &request.target,
        UiProfileMutationV1::ResetScene {
            scene_id: request.scene_id,
            replacement,
            restore_surface_instance_specs,
        },
    )
    .map_err(display_error)?;
    reconcile_studio_after_profile(&app, &state)
        .await
        .map_err(display_error)?;
    Ok(snapshot)
}

#[cfg(test)]
#[path = "ui_profile/profile_contract_tests.rs"]
mod profile_contract_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use rho_ui_contract::{
        ApplicationComponentId, RuntimeRegistrySnapshotV1, SurfaceDefinitionV1,
        SurfaceInstancePolicyV1, SurfaceInstanceQuotaClassV1, SurfaceInteractionKindV1,
        SurfaceModeV1, SurfaceOriginV1, SurfacePresentationClassV1, SurfaceRendererKindV1,
        SurfaceScopeV1, SurfaceSizingHintsV1,
    };

    fn factory(id: &str) -> SurfaceFactoryRegistrationV1 {
        SurfaceFactoryRegistrationV1 {
            definition: SurfaceDefinitionV1 {
                surface_id: rho_ui_contract::SurfaceId::new(id).unwrap(),
                contract_major: 1,
                label: id.to_string(),
                purpose: "profile fixture".to_string(),
                icon: None,
                renderer_kind: SurfaceRendererKindV1::TrustedHost,
                scope: SurfaceScopeV1::Project,
                instance_policy: SurfaceInstancePolicyV1::MultiInstance,
                instance_quota_class: SurfaceInstanceQuotaClassV1::Standard,
                resource_kinds: vec![],
                modes: vec![SurfaceModeV1 {
                    mode_id: rho_ui_contract::SurfaceModeId::new("default").unwrap(),
                    label: "Default".to_string(),
                    interaction_kind: SurfaceInteractionKindV1::Interactive,
                }],
                sizing_hints: SurfaceSizingHintsV1 {
                    min_inline: 100,
                    min_block: 60,
                    ideal_inline: Some(400),
                    ideal_block: Some(300),
                    max_inline: None,
                    max_block: None,
                    stretch_inline: true,
                    stretch_block: true,
                    presentation_classes: vec![SurfacePresentationClassV1::Full],
                },
                accepted_contexts: vec!["project".to_string()],
                commands: vec![],
                origin: SurfaceOriginV1::Application {
                    component_id: ApplicationComponentId::new(id).unwrap(),
                },
            },
            activation_generation: 1,
        }
    }

    fn runtimes(project_id: &ProjectId) -> RuntimeRegistrySnapshotV1 {
        let mut fixture = rho_ui_contract::golden_contract_fixture().runtime_registry_snapshot;
        fixture.project_id = project_id.clone();
        for runtime in &mut fixture.instances {
            runtime.project_id = project_id.clone();
        }
        fixture
    }

    #[test]
    fn store_round_trips_unicode_root_and_isolates_two_projects() {
        let temp = tempfile::tempdir().unwrap();
        let root_a = temp.path().join("科学 Project A");
        let root_b = temp.path().join("Project B");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        let root_a = root_a.canonicalize().unwrap();
        let root_b = root_b.canonicalize().unwrap();
        let store = ProjectUiProfileStore::new(temp.path().join("app-data")).unwrap();
        let project_a = ProjectId::new("project:a").unwrap();
        let project_b = ProjectId::new("project:b").unwrap();
        let factories = vec![factory("rho.status")];
        let a = store
            .load_or_create(&root_a, &project_a, || {
                default_profile_seed(&project_a, &factories, &runtimes(&project_a))
            })
            .unwrap();
        assert_eq!(a.status, UiProfileLoadStatusV1::Created);
        let b = store
            .load_or_create(&root_b, &project_b, || {
                default_profile_seed(&project_b, &factories, &runtimes(&project_b))
            })
            .unwrap();
        assert_ne!(a.profile.project_id, b.profile.project_id);
        let reopened = ProjectUiProfileStore::new(temp.path().join("app-data"))
            .unwrap()
            .load_or_create(&root_a, &project_a, || unreachable!())
            .unwrap();
        assert_eq!(reopened.profile, a.profile);
        assert_eq!(reopened.status, UiProfileLoadStatusV1::Clean);
    }

    #[test]
    fn obsolete_unshipped_profile_is_archived_and_rebuilt_without_migration() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Rapid profile");
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let store = ProjectUiProfileStore::new(temp.path().join("app-data")).unwrap();
        let project = ProjectId::new("project:rapid-profile").unwrap();
        let factories = vec![factory("rho.status")];
        let seed = default_profile_seed(&project, &factories, &runtimes(&project)).unwrap();
        let mut obsolete = serde_json::to_value(StoredProjectUiProfileV1 {
            normalized_project_root: ProjectUiProfileStore::normalized_root(&root),
            profile: seed,
        })
        .unwrap();
        obsolete["profile"]["schema_version"] = json!(1);
        let obsolete_bytes = serde_json::to_vec_pretty(&obsolete).unwrap();
        std::fs::write(store.path(&root), &obsolete_bytes).unwrap();

        let loaded = store
            .load_or_create(&root, &project, || {
                default_profile_seed(&project, &factories, &runtimes(&project))
            })
            .unwrap();
        assert_eq!(
            loaded.profile.schema_version,
            PROJECT_UI_PROFILE_SCHEMA_VERSION
        );
        assert_eq!(loaded.status, UiProfileLoadStatusV1::Created);
        assert!(loaded.recovery_detail.unwrap().contains("Rebuilt"));
        assert_eq!(
            std::fs::read(store.obsolete_path(&root, 1)).unwrap(),
            obsolete_bytes
        );
        assert!(
            ProjectUiProfileStore::decode(
                &std::fs::read(store.path(&root)).unwrap(),
                &root,
                &project,
            )
            .is_ok()
        );
    }

    #[test]
    fn cas_serializes_concurrent_writers_and_failure_preserves_durable_main() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Project");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let store = ProjectUiProfileStore::new(temp.path().join("app-data")).unwrap();
        let project = ProjectId::new("project:cas").unwrap();
        let factories = vec![factory("rho.status")];
        let initial = store
            .load_or_create(&root, &project, || {
                default_profile_seed(&project, &factories, &runtimes(&project))
            })
            .unwrap()
            .profile;
        let candidate = apply_ui_profile_mutation(
            &initial,
            initial.revision,
            UiProfileMutationV1::SetActiveMode {
                mode: UiProfileModeV1::Vibe,
            },
        )
        .unwrap();
        let left = store.clone();
        let right = store.clone();
        let left_root = root.clone();
        let right_root = root.clone();
        let left_candidate = candidate.clone();
        let right_candidate = candidate.clone();
        let first = std::thread::spawn(move || left.save(&left_root, 1, &left_candidate));
        let second = std::thread::spawn(move || right.save(&right_root, 1, &right_candidate));
        assert_ne!(
            first.join().unwrap().is_ok(),
            second.join().unwrap().is_ok()
        );

        let durable = store
            .load_or_create(&root, &project, || unreachable!())
            .unwrap()
            .profile;
        let next = apply_ui_profile_mutation(
            &durable,
            durable.revision,
            UiProfileMutationV1::SetActiveMode {
                mode: UiProfileModeV1::Studio,
            },
        )
        .unwrap();
        store.inject_failure(ProfileStoreFailurePoint::BeforeMainReplace);
        assert!(store.save(&root, durable.revision, &next).is_err());
        let reopened = ProjectUiProfileStore::new(temp.path().join("app-data"))
            .unwrap()
            .load_or_create(&root, &project, || unreachable!())
            .unwrap();
        assert_eq!(reopened.profile, durable);
    }

    #[test]
    fn corrupt_or_missing_main_recovers_exact_backup_and_no_backup_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Project");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let data = temp.path().join("app-data");
        let store = ProjectUiProfileStore::new(data.clone()).unwrap();
        let project = ProjectId::new("project:recovery").unwrap();
        let factories = vec![factory("rho.status")];
        let initial = store
            .load_or_create(&root, &project, || {
                default_profile_seed(&project, &factories, &runtimes(&project))
            })
            .unwrap()
            .profile;
        let candidate = apply_ui_profile_mutation(
            &initial,
            1,
            UiProfileMutationV1::SetActiveMode {
                mode: UiProfileModeV1::Vibe,
            },
        )
        .unwrap();
        store.save(&root, 1, &candidate).unwrap();
        std::fs::write(store.path(&root), b"{partial").unwrap();
        let recovered = ProjectUiProfileStore::new(data.clone())
            .unwrap()
            .load_or_create(&root, &project, || unreachable!())
            .unwrap();
        assert_eq!(recovered.profile, initial);
        assert_eq!(recovered.status, UiProfileLoadStatusV1::RecoveredBackup);

        std::fs::remove_file(store.backup_path(&root)).unwrap();
        std::fs::write(store.path(&root), b"{broken").unwrap();
        assert!(
            ProjectUiProfileStore::new(data)
                .unwrap()
                .load_or_create(&root, &project, || unreachable!())
                .is_err()
        );
    }

    #[test]
    fn state_reopens_project_a_after_b_and_failed_mutation_never_looks_saved() {
        let temp = tempfile::tempdir().unwrap();
        let root_a = temp.path().join("Project A");
        let root_b = temp.path().join("Project B");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        let root_a = root_a.canonicalize().unwrap();
        let root_b = root_b.canonicalize().unwrap();
        let state = ProjectUiProfileState::new(temp.path().join("app-data")).unwrap();
        let project_a = ProjectId::new("project:state-a").unwrap();
        let project_b = ProjectId::new("project:state-b").unwrap();
        let factories = vec![factory("rho.status")];
        let a = state
            .reconcile(
                root_a.clone(),
                project_a.clone(),
                &factories,
                &runtimes(&project_a),
            )
            .unwrap();
        let a = state
            .mutate(
                &UiProfileRevisionRequestV1 {
                    project_id: project_a.clone(),
                    expected_profile_revision: a.profile.revision,
                },
                UiProfileMutationV1::SetActiveMode {
                    mode: UiProfileModeV1::Vibe,
                },
            )
            .unwrap();
        let b = state
            .reconcile(root_b, project_b.clone(), &factories, &runtimes(&project_b))
            .unwrap();
        assert_eq!(b.profile.project_id, project_b);
        let reopened_a = state
            .reconcile(
                root_a.clone(),
                project_a.clone(),
                &factories,
                &runtimes(&project_a),
            )
            .unwrap();
        assert_eq!(reopened_a.profile, a.profile);
        assert_eq!(reopened_a.profile.active_mode, UiProfileModeV1::Vibe);

        state
            .store
            .inject_failure(ProfileStoreFailurePoint::BeforeMainReplace);
        let before = state.snapshot().unwrap();
        let failed = state.mutate(
            &UiProfileRevisionRequestV1 {
                project_id: project_a.clone(),
                expected_profile_revision: before.profile.revision,
            },
            UiProfileMutationV1::SetActiveMode {
                mode: UiProfileModeV1::Studio,
            },
        );
        assert!(failed.is_err());
        assert_eq!(state.snapshot().unwrap(), before);
        let durable = ProjectUiProfileStore::new(temp.path().join("app-data"))
            .unwrap()
            .load_or_create(&root_a, &project_a, || unreachable!())
            .unwrap();
        assert_eq!(durable.profile, before.profile);
    }

    #[test]
    fn page_transaction_is_durable_stale_safe_recoverable_and_project_isolated() {
        let temp = tempfile::tempdir().unwrap();
        let root_a = temp.path().join("Vibe A");
        let root_b = temp.path().join("Vibe B");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        let root_a = root_a.canonicalize().unwrap();
        let root_b = root_b.canonicalize().unwrap();
        let state = ProjectUiProfileState::new(temp.path().join("app-data")).unwrap();
        let project_a = ProjectId::new("project:vibe-a").unwrap();
        let project_b = ProjectId::new("project:vibe-b").unwrap();
        let factories = vec![factory("rho.status")];
        let initial_a = state
            .reconcile(
                root_a.clone(),
                project_a.clone(),
                &factories,
                &runtimes(&project_a),
            )
            .unwrap();
        let page = initial_a.profile.vibe_pages[0].clone();
        let inserted_id = next_block_id();
        let edited_page = apply_vibe_page_mutation(
            &page,
            page.page_revision,
            VibePageMutationV1::InsertBlock {
                section_id: page.sections[0].section_id.clone(),
                index: page.sections[0].blocks.len(),
                block: VibeBlockV1 {
                    block_id: inserted_id.clone(),
                    content: VibeBlockContentV1::RichText {
                        document: VibeRichTextDocumentV1::plain_text("Durable evidence"),
                    },
                },
                grid_placement: None,
            },
        )
        .unwrap();
        let saved = state
            .mutate(
                &UiProfileRevisionRequestV1 {
                    project_id: project_a.clone(),
                    expected_profile_revision: initial_a.profile.revision,
                },
                UiProfileMutationV1::ReplacePage {
                    page: edited_page.clone(),
                },
            )
            .unwrap();
        assert_eq!(saved.profile.vibe_pages[0], edited_page);
        assert!(
            export_vibe_page(&edited_page)
                .unwrap()
                .markdown
                .contains("Durable evidence")
        );

        let before_stale = state.snapshot().unwrap();
        assert!(
            state
                .mutate(
                    &UiProfileRevisionRequestV1 {
                        project_id: project_a.clone(),
                        expected_profile_revision: initial_a.profile.revision,
                    },
                    UiProfileMutationV1::ReplacePage { page: edited_page },
                )
                .is_err()
        );
        assert_eq!(state.snapshot().unwrap(), before_stale);

        let project_b_snapshot = state
            .reconcile(root_b, project_b.clone(), &factories, &runtimes(&project_b))
            .unwrap();
        assert!(
            !project_b_snapshot.profile.vibe_pages[0]
                .sections
                .iter()
                .flat_map(|section| &section.blocks)
                .any(|block| block.block_id == inserted_id)
        );

        let reopened = state
            .reconcile(
                root_a.clone(),
                project_a.clone(),
                &factories,
                &runtimes(&project_a),
            )
            .unwrap();
        assert!(
            reopened.profile.vibe_pages[0]
                .sections
                .iter()
                .flat_map(|section| &section.blocks)
                .any(|block| block.block_id == inserted_id)
        );

        let before_failure = state.snapshot().unwrap();
        let mut failed_page = before_failure.profile.vibe_pages[0].clone();
        failed_page.page_revision += 1;
        failed_page.label = "Must not look saved".to_string();
        state
            .store
            .inject_failure(ProfileStoreFailurePoint::BeforeMainReplace);
        assert!(
            state
                .mutate(
                    &UiProfileRevisionRequestV1 {
                        project_id: project_a.clone(),
                        expected_profile_revision: before_failure.profile.revision,
                    },
                    UiProfileMutationV1::ReplacePage { page: failed_page },
                )
                .is_err()
        );
        assert_eq!(state.snapshot().unwrap(), before_failure);
        let durable = ProjectUiProfileStore::new(temp.path().join("app-data"))
            .unwrap()
            .load_or_create(&root_a, &project_a, || unreachable!())
            .unwrap();
        assert_eq!(durable.profile, before_failure.profile);
    }

    #[test]
    fn oversized_profile_is_rejected_before_the_durable_file_changes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Project");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let store = ProjectUiProfileStore::new(temp.path().join("app-data")).unwrap();
        let project = ProjectId::new("project:budget").unwrap();
        let factories = vec![factory("rho.status")];
        let initial = store
            .load_or_create(&root, &project, || {
                default_profile_seed(&project, &factories, &runtimes(&project))
            })
            .unwrap()
            .profile;
        let durable_before = std::fs::read(store.path(&root)).unwrap();
        let mut oversized = initial.clone();
        oversized.revision += 1;
        oversized.surface_instance_specs[0].view_state = json!({
            "payload": "x".repeat(2 * 1024 * 1024),
        });
        assert!(store.save(&root, initial.revision, &oversized).is_err());
        assert_eq!(std::fs::read(store.path(&root)).unwrap(), durable_before);
        assert!(!store.backup_path(&root).exists());
    }
}
