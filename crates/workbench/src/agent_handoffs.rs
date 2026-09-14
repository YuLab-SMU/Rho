//! Browser-only handoff edge. No model, native session or scientific action starts here.
use super::{AppState, component_agents::application_failure};
use axum::{extract::State, http::HeaderMap, response::{IntoResponse, Response}, Json};
use rho_contract::*;
use rho_host::{ApplicationError, NextHost};

fn caller(headers: &HeaderMap, window: &ApplicationWindowRef) -> Result<CallContext, ApplicationError> {
    if headers.get("x-rho-studio-window").and_then(|value|value.to_str().ok()) != Some(window.window_id.as_str()) {
        return Err(ApplicationError::InvalidBridge);
    }
    let mut context=NextHost::local_context();
    context.connection_id=format!("studio:{}",window.window_id);
    Ok(context)
}

pub(super) async fn query(State(state): State<AppState>, headers: HeaderMap, Json(request): Json<AgentHandoffsQuery>) -> Response {
    let context=match caller(&headers,&request.window) {
        Ok(context)=>context, Err(error)=>return application_failure(error,None,Some(ComponentSubmissionState::Rejected)),
    };
    let hosting=state.hosting.read().await;
    let Some(selected)=&hosting.selected else {return application_failure(ApplicationError::NotFound,None,Some(ComponentSubmissionState::Rejected));};
    match state.handoffs.query(&state.task_agents,&selected.host,&context,request).await {
        Ok(value)=>Json(value).into_response(),
        Err(error)=>application_failure(error,None,Some(ComponentSubmissionState::Rejected)),
    }
}

pub(super) async fn command(State(state): State<AppState>, headers: HeaderMap, Json(request): Json<AgentHandoffCommand>) -> Response {
    let context=match caller(&headers,&request.window) {
        Ok(context)=>context, Err(error)=>return application_failure(error,Some(request.request_id),Some(ComponentSubmissionState::Rejected)),
    };
    let hosting=state.hosting.read().await;
    let Some(selected)=&hosting.selected else {return application_failure(ApplicationError::NotFound,Some(request.request_id),Some(ComponentSubmissionState::Rejected));};
    match state.handoffs.transfer(&state.task_agents,&state.component_agents,&selected.host,&context,&request).await {
        Ok(receipt)=>Json(receipt).into_response(),
        Err(error)=>{
            let proof=state.handoffs.query(&state.task_agents,&selected.host,&context,AgentHandoffsQuery {
                project_root:request.project_root.clone(),window:request.window.clone(),query:AgentHandoffQuery::Receipt {request_id:request.request_id.clone()},
            }).await;
            let submission=match proof {
                Ok(AgentHandoffQueryResult::Receipt {receipt:Some(_)} )=>ComponentSubmissionState::Accepted,
                Ok(AgentHandoffQueryResult::Receipt {receipt:None})=>ComponentSubmissionState::Rejected,
                _=>ComponentSubmissionState::Unknown,
            };
            application_failure(error,Some(request.request_id),Some(submission))
        },
    }
}
