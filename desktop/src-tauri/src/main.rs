#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod acceptance_bridge;
mod agent_credential_vault;
mod agent_llm;
mod application_lifecycle;
mod application_state;
mod check_runtime;
mod commands;
mod digest;
mod git;
mod git_commands;
mod git_review;
mod internal_extensions;
mod platform;
mod plugin_surface_runtime;
mod project;
mod project_transition;
mod resource_registry;
mod runtime_registry;
mod shell;
mod smoke;
mod startup_runtime;
mod studio_runtime;
mod surface_runtime;
mod ui_profile;
mod ui_runtime;
mod update;
mod workbench_projection;
mod workspace_lifecycle;
mod workspace_plugins;

use application_lifecycle::shutdown_application;
pub(crate) use application_state::AppState;
#[cfg(test)]
use application_state::{active_context, persist_workspace_identity, store_executor};
#[cfg(test)]
use commands::agent_execution::{AgentTaskEntry, agent_turn_admission_error};
#[cfg(test)]
use digest::text_sha256;
use internal_extensions::*;
use project_transition::*;
use startup_runtime::*;
use workspace_lifecycle::*;

#[cfg(test)]
use commands::agent_execution::interrupt_all_agent_tasks;
#[cfg(test)]
use commands::agent_execution::{agent_retry_source, cancel_agent_turn_state};
use commands::agent_files::AgentFileMutationRegistry;
#[cfg(test)]
use commands::agent_files::recover_incomplete_agent_file_mutations;
#[cfg(test)]
use commands::agent_files::{
    AgentFileApplyRequest, AgentFileApplyTestControl, AgentFileUndoRequest,
    PersistedAgentFileProposal, append_agent_file_mutation_event, apply_agent_file_edit_state,
    classify_agent_file_postwrite_failure, classify_agent_file_write_failure,
    ensure_agent_file_proposal_turn_terminal, persist_agent_file_mutation_event_to_store,
    undo_agent_file_edit_state, validate_persisted_agent_file_proposal_structure,
};
#[cfg(test)]
use commands::render::RenderJobState;
use commands::render::render_job_is_terminal;
#[cfg(test)]
use commands::render::{attach_render_artifact, finish_render_job, reconcile_render_job};
#[cfg(test)]
use commands::workspace::ExtensionWorkspaceSnapshotAdapter;
#[cfg(test)]
use commands::workspace::expected_workspace;
#[cfg(test)]
use commands::workspace::{
    ExecuteRequest, ExecuteSourceRange, snapshot_workspace_with_state,
    validate_execute_source_range_shape,
};

use std::collections::HashMap;
#[cfg(windows)]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock as SyncRwLock};

use agent_llm::AgentModelTestControl;
#[cfg(test)]
use agent_llm::{
    AgentContextCapacityRequest, AgentLlmSettingsView, AgentModelProfile, AgentProviderProfile,
};
use anyhow::Context;
#[cfg(test)]
use project::durable_project_root;
#[cfg(test)]
use project::{MAX_VIEWER_FILE_BYTES, MAX_VIEWER_HTML_BYTES};
use project::{ProjectSessionStore, default_project_root};
use rho_server::coordinator::{
    AgentWorkspaceLane, PendingApprovalRegistry, dispatch_workspace_request,
    dispatch_workspace_request_with_execution_id,
};
use rho_store::normalize_project_root;
use tauri::Manager;
use tokio::sync::{Mutex, RwLock};

#[cfg(test)]
#[path = "agent_contract_tests.rs"]
mod agent_contract_tests;

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;

fn main() {
    // On Linux, WebKitGTK's DMABUF renderer fails to allocate GBM buffers on
    // NVIDIA proprietary graphics stacks, leaving the webview blank. Default
    // to the software renderer unless the environment already overrides it.
    if cfg!(target_os = "linux") && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: this runs at the top of main() before any additional
        // threads are spawned, so no concurrent environment access exists.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    std::panic::set_hook(Box::new(|information| {
        write_startup_log(&format!("Rho desktop panic: {information}"));
    }));
    let arguments = std::env::args().collect::<Vec<_>>();
    let smoke_agent = arguments.iter().any(|argument| argument == "--smoke-agent");
    if smoke_agent || arguments.iter().any(|argument| argument == "--smoke-test") {
        let runtime = tokio::runtime::Runtime::new().expect("creating smoke-test runtime");
        match runtime.block_on(smoke::smoke_test(smoke_agent)) {
            Ok(report) => {
                println!("{}", serde_json::to_string_pretty(&report).unwrap());
                return;
            }
            Err(error) => {
                eprintln!("Rho desktop smoke test failed: {error:#}");
                std::process::exit(1);
            }
        }
    }
    let run_result = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = match acceptance_bridge::application_data_dir_override()
                .context("resolving isolated acceptance application data directory")?
            {
                Some(data_dir) => data_dir,
                None => app
                    .path()
                    .app_local_data_dir()
                    .context("resolving Rho application data directory")?,
            };
            initialize_startup_log(&data_dir);
            write_startup_log("Rho desktop shell setup started");
            let ark = locate_ark(app)?;
            let project_store = ProjectSessionStore::new(data_dir.clone()).map_err(|error| {
                write_startup_log(&format!("Rho project session setup failed: {error:#}"));
                error
            })?;
            let ui_profile =
                ui_profile::ProjectUiProfileState::new(data_dir.clone()).map_err(|error| {
                    write_startup_log(&format!("Rho UI Profile setup failed: {error:#}"));
                    error
                })?;
            let selected_rscript = load_selected_rscript(&data_dir);
            let extension_host =
                tauri::async_runtime::block_on(desktop_extension_host()).map_err(|error| {
                    write_startup_log(&format!("Internal extension host setup failed: {error:#}"));
                    error
                })?;
            app.manage(AppState {
                data_dir,
                ark,
                config: SyncRwLock::new(None),
                selected_rscript: SyncRwLock::new(selected_rscript),
                startup: SyncRwLock::new(StartupView {
                    phase: "shell_ready".to_string(),
                    busy: false,
                    runtime: None,
                    issue: None,
                }),
                project_store,
                project_root: RwLock::new(default_project_root()),
                project_watcher: Mutex::new(None),
                session: RwLock::new(None),
                context: Mutex::new(None),
                store_executor: tokio::sync::OnceCell::new(),
                approvals: Arc::new(PendingApprovalRegistry::default()),
                environment_approvals: Arc::new(PendingApprovalRegistry::default()),
                project_transition_gate: Arc::new(Mutex::new(())),
                extension_host,
                plugin_permissions: crate::workspace_plugins::PendingPluginPermissionRegistry::new(
                ),
                agent_tasks: Arc::new(Mutex::new(HashMap::new())),
                agent_workspace_lane: Arc::new(AgentWorkspaceLane::default()),
                agent_file_mutations: Arc::new(AgentFileMutationRegistry::default()),
                #[cfg(test)]
                agent_file_apply_test_control: AgentFileApplyTestControl::default(),
                agent_llm_test_control: AgentModelTestControl::default(),
                switch_test_control: SwitchTestControl::default(),
                shutdown_started: AtomicBool::new(false),
                render_jobs: Arc::new(Mutex::new(HashMap::new())),
                render_tasks: Arc::new(Mutex::new(HashMap::new())),
                surface_runtime: surface_runtime::SurfaceRuntimeState::default(),
                plugin_surface_runtime: plugin_surface_runtime::PluginSurfaceRuntimeState::default(
                ),
                check_runtime: check_runtime::CheckRuntimeState::default(),
                studio_runtime: studio_runtime::StudioRuntimeState::default(),
                runtime_registry: runtime_registry::RuntimeRegistryState::default(),
                resource_registry: resource_registry::ResourceRegistryState::default(),
                ui_profile,
                ui_runtime: ui_runtime::UiRuntimeState::default(),
                workbench_projection: workbench_projection::WorkbenchProjectionState::default(),
            });
            app.manage(shell::NativeUpdaterState::new());
            #[cfg(debug_assertions)]
            {
                // Debug-only acceptance automation bridge; failures are
                // logged to the startup log and never abort shell setup.
                acceptance_bridge::start_if_enabled(app.handle());
            }
            let heartbeat_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                monitor_workspace_plugin_heartbeats(heartbeat_app).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            shell::app_info,
            shell::check_for_updates,
            shell::install_native_update,
            shell::open_rho_website,
            shell::show_rho_license,
            acceptance_bridge::acceptance_bridge_result,
            acceptance_bridge::acceptance_bridge_active,
            commands::startup::startup_status,
            commands::startup::startup_bootstrap,
            commands::startup::startup_choose_rscript,
            commands::startup::startup_diagnostics,
            commands::startup::startup_open_log_directory,
            commands::startup::agent_runtime_status,
            commands::startup::agent_runtime_retry,
            ui_runtime::ui_kernel_snapshot,
            ui_runtime::ui_set_selection,
            workbench_projection::workbench_projection_snapshot,
            surface_runtime::surface_list,
            surface_runtime::surface_open,
            surface_runtime::surface_update,
            surface_runtime::surface_close,
            surface_runtime::surface_suspend,
            surface_runtime::surface_resume,
            plugin_surface_runtime::plugin_surface_document,
            plugin_surface_runtime::plugin_surface_event,
            check_runtime::check_project_run,
            check_runtime::check_result,
            studio_runtime::studio_scene,
            studio_runtime::studio_apply,
            studio_runtime::studio_undo,
            studio_runtime::studio_redo,
            ui_profile::ui_profile_snapshot,
            ui_profile::ui_profile_set_mode,
            ui_profile::ui_profile_select_scene,
            ui_profile::ui_profile_select_page,
            ui_profile::ui_profile_page_apply,
            ui_profile::ui_profile_page_export,
            ui_profile::ui_profile_scene_duplicate,
            ui_profile::ui_profile_scene_save,
            ui_profile::ui_profile_scene_rename,
            ui_profile::ui_profile_scene_delete,
            ui_profile::ui_profile_scene_reset,
            runtime_registry::runtime_list,
            runtime_registry::runtime_create,
            runtime_registry::runtime_attach,
            runtime_registry::runtime_detach,
            runtime_registry::runtime_interrupt,
            runtime_registry::runtime_restart,
            runtime_registry::runtime_stop,
            runtime_registry::runtime_execution_start,
            runtime_registry::runtime_execution_get,
            runtime_registry::runtime_execution_list,
            runtime_registry::runtime_output_search,
            runtime_registry::runtime_output_policy_get,
            runtime_registry::runtime_output_policy_update,
            runtime_registry::runtime_output_page,
            runtime_registry::runtime_output_reference,
            runtime_registry::runtime_output_prune,
            runtime_registry::runtime_execution_delete,
            runtime_registry::runtime_output_follow,
            resource_registry::resource_list,
            resource_registry::resource_resolve,
            resource_registry::resource_read,
            resource_registry::resource_update_draft,
            resource_registry::resource_save,
            resource_registry::resource_reload,
            resource_registry::resource_rename,
            resource_registry::resource_delete,
            commands::startup::workspace_start,
            commands::startup::workspace_status,
            commands::project_session::project_state,
            commands::project_session::project_mark_files_changed,
            commands::project_session::project_open,
            commands::project_session::project_pick_directory,
            commands::project_session::project_restore_session,
            commands::project_session::project_save_session,
            commands::project_session::project_read_file,
            commands::project_session::viewer_read_file,
            commands::project_session::project_write_file,
            commands::project_session::project_create_file,
            commands::project_session::project_delete_file,
            commands::agent_files::apply_agent_file_edit,
            commands::agent_files::undo_agent_file_edit,
            commands::workspace::execute_r,
            commands::workspace::snapshot_workspace,
            commands::workspace::inspect_object,
            commands::workspace::inspect_data_object,
            commands::workspace::read_data_view,
            commands::render::render_document,
            commands::render::render_document_job,
            commands::render::render_job_status,
            commands::render::cancel_render_job,
            commands::environment::request_environment_operation_preview,
            commands::environment::list_environment_operation_requests,
            commands::environment::get_environment_operation_request,
            commands::environment::respond_environment_operation,
            commands::environment::list_installed_packages,
            commands::environment::list_lockfile_packages,
            commands::plugins::list_workspace_plugins,
            commands::plugins::get_workspace_plugin_transition,
            commands::plugins::request_workspace_plugin_enable,
            commands::plugins::disable_workspace_plugin,
            commands::plugins::retry_workspace_plugin,
            commands::plugins::accept_workspace_plugin_update,
            commands::plugins::rollback_workspace_plugin,
            commands::plugins::uninstall_workspace_plugin,
            commands::plugins::restore_workspace_plugin,
            commands::plugins::list_plugin_permission_requests,
            commands::plugins::get_plugin_permission_request,
            commands::plugins::respond_plugin_permission,
            commands::plugins::list_plugin_grants,
            commands::plugins::revoke_plugin_grant,
            commands::plugins::list_plugin_contributions,
            commands::plugins::invoke_plugin_command,
            commands::plugins::open_plugin_viewer,
            commands::plugins::get_plugin_panel_document,
            commands::runs::list_runs,
            commands::artifacts::list_plot_artifacts,
            commands::artifacts::read_plot_artifact,
            commands::artifacts::export_plot_artifact,
            commands::artifacts::export_data_view_artifact,
            commands::artifacts::list_artifact_records,
            commands::artifacts::get_artifact_record,
            commands::artifacts::prune_plot_payloads,
            commands::artifacts::get_project_retention_summary,
            commands::project_session::list_project_skills,
            commands::artifacts::clear_artifact_records,
            commands::artifacts::clear_plot_artifacts,
            commands::runs::list_problems,
            commands::runs::get_run_detail,
            commands::runs::compare_runs,
            commands::runs::audit_reproducibility,
            commands::editor::editor_package_functions,
            commands::editor::editor_function_help,
            commands::editor::editor_function_documentation,
            commands::editor::editor_lint_file,
            commands::editor::editor_format_source,
            commands::editor::editor_goto_definition,
            commands::editor::editor_find_project_references,
            commands::editor::editor_discover_chunks,
            commands::runs::retry_run,
            commands::agent_execution::run_agent,
            commands::agent_execution::agent_context_preview,
            commands::agent_llm::agent_llm_settings,
            commands::agent_llm::agent_llm_save_provider,
            commands::agent_llm::agent_llm_delete_provider,
            commands::agent_llm::agent_llm_set_credential,
            commands::agent_llm::agent_llm_delete_credential,
            commands::agent_llm::agent_llm_view_credential,
            commands::agent_llm::agent_llm_save_model,
            commands::agent_llm::agent_llm_set_context_capacity,
            commands::agent_llm::agent_llm_declare_model_capability,
            commands::agent_llm::agent_llm_delete_model,
            commands::agent_llm::agent_llm_select_model,
            commands::agent_llm::agent_llm_save_capability_route,
            commands::agent_llm::agent_llm_delete_capability_route,
            commands::agent_llm::agent_llm_declare_model_capabilities,
            commands::agent_llm::agent_llm_refresh_credentials,
            commands::agent_llm::agent_llm_test_model,
            commands::agent_llm::agent_llm_cancel_test,
            commands::agent_llm::agent_llm_catalog,
            commands::agent_llm::agent_llm_discover_models,
            commands::agent_conversation::list_agent_conversations,
            commands::agent_conversation::create_agent_conversation,
            commands::agent_conversation::list_agent_turns,
            commands::agent_execution::retry_agent_turn,
            commands::agent_conversation::delete_agent_conversation,
            commands::agent_execution::clear_agent_history,
            commands::agent_execution::list_approval_requests,
            commands::agent_execution::get_agent_turn_detail,
            commands::agent_execution::respond_approval,
            commands::runtime_control::interrupt_r,
            commands::runtime_control::cancel_run,
            commands::agent_execution::cancel_agent_turn,
            commands::runtime_control::restart_workspace,
            git_commands::git_status,
            git_commands::git_log,
            git_commands::git_diff,
            git_commands::git_stage,
            git_commands::git_commit,
            git_commands::git_diff_unified,
            git_commands::git_hunk_stage,
            git_commands::git_hunk_unstage,
            git_commands::git_restore_file,
            git_commands::git_unstage_file,
            git_commands::git_staged_revision,
            git_commands::git_list_conflicts,
            git_commands::git_resolve_conflict,
            commands::runtime_control::targets_status,
            commands::evidence::resolve_doi,
            commands::evidence::create_evidence_entry,
            commands::evidence::list_evidence_entries,
            commands::evidence::get_evidence_entry,
            commands::evidence::delete_evidence_entry,
            commands::evidence::create_evidence_claim,
            commands::evidence::list_evidence_claims,
            commands::evidence::review_evidence_claim,
            commands::evidence::delete_evidence_claim,
        ])
        .build(tauri::generate_context!());
    match run_result {
        Ok(app) => {
            app.run(|app_handle, event| {
                if let tauri::RunEvent::ExitRequested { api, code, .. } = event
                    && code.is_none()
                {
                    api.prevent_exit();
                    let state = app_handle.state::<AppState>();
                    if state.shutdown_started.swap(true, Ordering::SeqCst) {
                        return;
                    }

                    let app_handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app_handle.state::<AppState>();
                        let _ = shutdown_application(&state).await;
                        app_handle.exit(0);
                    });
                }
            });
        }
        Err(error) => {
            let detail = format!("Rho desktop could not start: {error:#}");
            write_startup_log(&detail);
            let _ = rfd::MessageDialog::new()
                .set_title("Rho could not start")
                .set_description(format!(
                    "Rho could not open its interface.\n\n{error}\n\nDiagnostic log:\n{}",
                    startup_log_path().display()
                ))
                .set_level(rfd::MessageLevel::Error)
                .set_buttons(rfd::MessageButtons::Ok)
                .show();
        }
    }
}
