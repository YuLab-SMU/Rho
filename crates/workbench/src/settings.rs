use super::*;
use rho_contract::{
    ApplicationState, ApplyRConfiguration, RConfiguration, RSelection, ReadApplicationState,
    WriteApplicationState,
};
use rho_host::{ApplicationStore, RuntimeConfiguration, discover_r, probe_r};

pub(super) async fn configure_startup(
    profile: &mut HostProfile,
    store: &ApplicationStore,
) -> RConfiguration {
    let candidates = discover_r();
    let (source, selection) = match &profile.runtime {
        RuntimeConfiguration::Ark {
            executable, r_home, ..
        } => (
            "launch",
            Some(RSelection {
                executable: r_home
                    .join("bin")
                    .join(if cfg!(windows) { "R.exe" } else { "R" })
                    .to_string_lossy()
                    .into_owned(),
                ark: executable.to_string_lossy().into_owned(),
            }),
        ),
        RuntimeConfiguration::Environment { .. } => {
            return RConfiguration {
                source: "launch".into(),
                current: None,
                candidates,
                error: None,
            };
        }
        RuntimeConfiguration::Project => {
            let saved = store.read("user", "runtime").and_then(|s| {
                if s.value.is_null() {
                    Ok(None)
                } else {
                    serde_json::from_value(s.value)
                        .map(Some)
                        .map_err(|e| e.to_string())
                }
            });
            match saved {
                Ok(Some(selection)) => ("saved", Some(selection)),
                Ok(None) => ("discovered", candidates.first().cloned()),
                Err(error) => {
                    return RConfiguration {
                        source: "saved".into(),
                        current: None,
                        candidates,
                        error: Some(error),
                    };
                }
            }
        }
    };
    let mut current = match selection {
        Some(selection) => Some(probe_r(&selection).await),
        None => None,
    };
    if source == "discovered" && !current.as_ref().is_some_and(|probe| probe.usable) {
        for candidate in candidates.iter().skip(1) {
            let probe = probe_r(candidate).await;
            if probe.usable {
                current = Some(probe);
                break;
            }
        }
    }
    let error = if let Some(probe) = &current {
        if probe.usable {
            let environment = match &profile.runtime {
                RuntimeConfiguration::Ark { environment, .. } => environment.clone(),
                _ => None,
            };
            profile.runtime = RuntimeConfiguration::Ark {
                executable: PathBuf::from(&probe.selection.ark),
                r_home: PathBuf::from(probe.r_home.as_ref().unwrap()),
                environment,
            };
            None
        } else {
            profile.runtime = RuntimeConfiguration::Project;
            Some(probe.diagnostics.join("\n"))
        }
    } else {
        Some("No R installation was found. Select an existing R and Ark in settings; files remain available.".into())
    };
    RConfiguration {
        source: source.into(),
        current,
        candidates,
        error,
    }
}

pub(super) async fn read_r(State(state): State<AppState>) -> Response {
    Json(state.hosting.read().await.r_configuration.clone()).into_response()
}
pub(super) async fn probe(
    State(_state): State<AppState>,
    Json(selection): Json<RSelection>,
) -> Response {
    Json(probe_r(&selection).await).into_response()
}
pub(super) async fn apply_r(
    State(state): State<AppState>,
    Json(request): Json<ApplyRConfiguration>,
) -> Response {
    let candidate = probe_r(&request.selection).await;
    if !candidate.usable {
        return (StatusCode::BAD_REQUEST, Json(candidate)).into_response();
    }
    let Ok(mut hosting) = state.hosting.try_write() else {
        return failure(
            StatusCode::CONFLICT,
            "Host has active requests; R was not changed",
        );
    };
    if let Some(selected) = &hosting.selected {
        if !request.end_session {
            return failure(
                StatusCode::CONFLICT,
                "Confirm that switching R ends the current session memory",
            );
        }
        if !selected.host.is_idle()
            || Arc::strong_count(&selected.host) != 1
            || selected.agents.has_live().await
        {
            return failure(
                StatusCode::CONFLICT,
                "Host is busy or an MCP session is attached; R was not changed",
            );
        }
    }
    // Validate and persist the selected candidate before ending the old session.
    let saved = state.application.read("user", "runtime").and_then(|old| {
        state.application.write(
            "user",
            &ApplicationState {
                value: serde_json::to_value(&candidate.selection).map_err(|e| e.to_string())?,
                ..old
            },
        )
    });
    if let Err(error) = saved {
        return failure(StatusCode::CONFLICT, error);
    }
    let root = hosting.selected.as_ref().map(|s| s.root.clone());
    if let Some(old) = hosting.selected.take() {
        old.host.drain().await;
        drop(old);
    }
    hosting.profile.runtime = RuntimeConfiguration::Ark {
        executable: PathBuf::from(&candidate.selection.ark),
        r_home: PathBuf::from(candidate.r_home.as_ref().unwrap()),
        environment: None,
    };
    hosting.r_configuration = RConfiguration {
        source: "saved".into(),
        current: Some(candidate),
        candidates: discover_r(),
        error: None,
    };
    if let Some(root) = root {
        match hosting.profile.open(&root).await {
            Ok(host) => hosting.selected = Some(SelectedHost::new(Arc::new(host), root)),
            Err(error) => {
                hosting.r_configuration.error = Some(format!(
                    "R startup failed; previous session memory has ended. {error}"
                ));
                hosting.profile.runtime = RuntimeConfiguration::Project;
                if let Ok(host) = hosting.profile.open(&root).await {
                    hosting.selected = Some(SelectedHost::new(Arc::new(host), root));
                }
            }
        }
    }
    Json(hosting.r_configuration.clone()).into_response()
}

async fn state_scope(state: &AppState, project: Option<&str>) -> Result<String, String> {
    if let Some(project) = project {
        let hosting = state.hosting.read().await;
        if hosting.selected.as_ref().and_then(|s| s.root.to_str()) != Some(project) {
            return Err("project changed; draft was not written".into());
        }
        Ok(format!("project:{project}"))
    } else {
        Ok("user".into())
    }
}
pub(super) async fn read_state(
    State(state): State<AppState>,
    Json(request): Json<ReadApplicationState>,
) -> Response {
    match state_scope(&state, request.project_root.as_deref())
        .await
        .and_then(|scope| state.application.read(&scope, &request.key))
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => failure(StatusCode::CONFLICT, error),
    }
}
pub(super) async fn write_state(
    State(state): State<AppState>,
    Json(request): Json<WriteApplicationState>,
) -> Response {
    if request.project_root.is_none() && request.state.key == "runtime" {
        return failure(
            StatusCode::BAD_REQUEST,
            "use the explicit R configuration endpoint",
        );
    }
    match state_scope(&state, request.project_root.as_deref())
        .await
        .and_then(|scope| state.application.write(&scope, &request.state))
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => failure(StatusCode::CONFLICT, error),
    }
}
