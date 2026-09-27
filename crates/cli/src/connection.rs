//! Thin transport to an already-running Workbench Host. No local Host/store/runtime is opened.
use crate::CliFailure;
use reqwest::{
    Client, Url,
    header::{AUTHORIZATION, HOST, HeaderMap, HeaderValue, ORIGIN},
};
use rho_contract::{Diagnostic, DiagnosticCode, DiagnosticContinuation, HostRequest, NextRead};
use rho_host::OperationError;
use serde_json::{Value, json};
use std::{
    io::Read,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
const URL_FILE_BYTES: usize = 16 * 1024;
const REPLY_BYTES: usize = 8 * 1024 * 1024;
const REQUEST_BYTES: usize = 272 * 1024;

pub(super) struct ConnectedHost {
    client: Client,
    origin: Url,
    token: String,
    project: String,
    test_project: Option<rho_plugin_protocol::TestProjectId>,
}
struct Endpoint {
    origin: Url,
    authority: String,
    token: String,
}
impl Endpoint {
    fn read(path: &Path) -> Result<Self, CliFailure> {
        let metadata = std::fs::metadata(path)
            .map_err(|_| invalid("Cannot inspect the private Workbench URL file"))?;
        if !metadata.is_file() || metadata.len() > URL_FILE_BYTES as u64 {
            return Err(invalid(
                "Private Workbench URL file must be a regular file of at most 16 KiB",
            ));
        }
        let mut file = std::fs::File::open(path)
            .map_err(|_| invalid("Cannot read the private Workbench URL file"))?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(URL_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid("Cannot read the private Workbench URL file"))?;
        if bytes.len() > URL_FILE_BYTES {
            return Err(invalid("Private Workbench URL exceeds 16 KiB"));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| invalid("Private Workbench URL is not UTF-8 text"))?;
        Self::parse(text.trim())
    }
    fn parse(text: &str) -> Result<Self, CliFailure> {
        let mut url = Url::parse(text).map_err(|_| invalid("Private Workbench URL is invalid"))?;
        if url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some_and(|query| query != "plugin-window" && query != "plugin-window=")
            || url.path() != "/"
        {
            return Err(invalid(
                "Connect requires a complete HTTP Workbench launch URL without userinfo, project-selection query or alternate path",
            ));
        }
        let address = url
            .host_str()
            .and_then(|host| {
                host.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .ok()
            })
            .filter(|ip| ip.is_loopback())
            .ok_or_else(|| invalid("Connect accepts only a literal loopback IP address"))?;
        let port = url
            .port_or_known_default()
            .filter(|p| *p != 0)
            .ok_or_else(|| invalid("Workbench URL has no usable port"))?;
        let fragment = url
            .fragment()
            .ok_or_else(|| invalid("Workbench URL is missing its private token fragment"))?
            .to_owned();
        let mut parsed = url.clone();
        parsed.set_query(Some(&fragment));
        let fields = parsed.query_pairs().collect::<Vec<_>>();
        if fields.len() != 1 || fields[0].0 != "token" {
            return Err(invalid(
                "Workbench URL must contain exactly one token fragment",
            ));
        }
        let token = fields[0].1.to_string();
        if token.is_empty() || token.len() > 1024 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(invalid("Workbench token is empty or invalid"));
        }
        let authority = match address {
            std::net::IpAddr::V4(ip) => format!("{ip}:{port}"),
            std::net::IpAddr::V6(ip) => format!("[{ip}]:{port}"),
        };
        url.set_fragment(None);
        url.set_query(None);
        url.set_path("/");
        Ok(Self {
            origin: url,
            authority,
            token,
        })
    }
}
impl ConnectedHost {
    pub(super) async fn open(
        path: &Path,
        expected_project: Option<&Path>,
        test_project: Option<rho_plugin_protocol::TestProjectId>,
    ) -> Result<Self, CliFailure> {
        let endpoint = Endpoint::read(path)?;
        let mut headers = HeaderMap::new();
        let mut authorization = format!("Bearer {}", endpoint.token)
            .parse::<HeaderValue>()
            .map_err(|_| invalid("Workbench token cannot be used as an HTTP header"))?;
        authorization.set_sensitive(true);
        headers.insert(AUTHORIZATION, authorization);
        headers.insert(
            HOST,
            endpoint
                .authority
                .parse::<HeaderValue>()
                .map_err(|_| invalid("Invalid loopback authority"))?,
        );
        headers.insert(
            ORIGIN,
            format!("http://{}", endpoint.authority)
                .parse::<HeaderValue>()
                .map_err(|_| invalid("Invalid loopback origin"))?,
        );
        let client = Client::builder()
            .default_headers(headers)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(660))
            .build()
            .map_err(|_| unavailable("Cannot construct the connected Host HTTP client"))?;
        let info_url = endpoint
            .origin
            .join("api/info")
            .map_err(|_| invalid("Invalid Workbench information endpoint"))?;
        let response = client.get(info_url).send().await.map_err(|_| {
            unavailable("Cannot reach the selected Workbench Host; no local Host was started")
        })?;
        let (status, info) = read_json(response, &endpoint.token, false, None).await?;
        if !status.is_success() {
            return Err(unavailable(&format!(
                "Workbench information request failed with HTTP {}; no action was submitted",
                status.as_u16()
            )));
        }
        let project=info.get("project_root").and_then(Value::as_str).filter(|p|!p.is_empty()&&p.len()<=16384).ok_or_else(||unavailable("The selected Workbench has no active project; select one there before sending requests"))?.to_owned();
        if let Some(expected) = expected_project {
            let raw = expected
                .to_str()
                .ok_or_else(|| invalid("Expected project path must be UTF-8"))?;
            let matches = raw == project
                || expected
                    .canonicalize()
                    .ok()
                    .and_then(|p| p.to_str().map(str::to_owned))
                    .as_deref()
                    == Some(project.as_str());
            if !matches {
                return Err(OperationError::ContentChanged(
                    "Connected Host project does not match --project; no action was submitted"
                        .into(),
                )
                .into());
            }
        }
        Ok(Self {
            client,
            origin: endpoint.origin,
            token: endpoint.token,
            project,
            test_project,
        })
    }
    pub(super) async fn submit(&self, request: Value) -> Result<Value, CliFailure> {
        let typed: HostRequest = serde_json::from_value(request.clone())
            .map_err(|_| invalid("Request is not a valid typed HostRequest"))?;
        let effectful = !matches!(
            typed,
            HostRequest::QuerySnapshot(_)
                | HostRequest::GetOperation { .. }
                | HostRequest::Subscribe { .. }
        );
        let id = format!(
            "cli-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| invalid("System clock is before Unix epoch"))?
                .as_nanos()
        );
        let mut frame = json!({"project_root":self.project,"frame":{"id":id,"request":request}});
        if let Some(id) = &self.test_project { frame["frame"]["test_project"] = json!(id); }
        let bytes =
            serde_json::to_vec(&frame).map_err(|_| invalid("Host request cannot be encoded"))?;
        if bytes.len() > REQUEST_BYTES {
            return Err(OperationError::BudgetExceeded(
                "Workbench request exceeds 272 KiB; no action was submitted".into(),
            )
            .into());
        }
        let url = self
            .origin
            .join("api/host")
            .map_err(|_| invalid("Invalid Workbench request endpoint"))?;
        let response = self
            .client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(bytes)
            .send()
            .await
            .map_err(|_| {
                transport_failure(
                    effectful,
                    Some(&request),
                    "Connection ended before a Host acknowledgement",
                )
            })?;
        let (status, reply) = read_json(response, &self.token, effectful, Some(&request)).await?;
        if status.is_redirection() {
            return Err(transport_failure(
                effectful,
                Some(&request),
                "Workbench redirected the request; redirects and automatic retries are disabled",
            ));
        }
        if !status.is_success() {
            if status == reqwest::StatusCode::CONFLICT {
                return Err(OperationError::ContentChanged("Workbench rejected the project precondition; no request was applied to another project".into()).into());
            }
            return Err(transport_failure(
                effectful,
                Some(&request),
                &format!("Workbench request returned HTTP {}", status.as_u16()),
            ));
        }
        if reply.get("id").and_then(Value::as_str) != Some(id.as_str()) {
            return Err(transport_failure(
                effectful,
                Some(&request),
                "Workbench reply did not match the transport request identity",
            ));
        }
        match reply.get("ok").and_then(Value::as_bool) {
            Some(true) => reply.get("result").cloned().ok_or_else(|| {
                transport_failure(
                    effectful,
                    Some(&request),
                    "Workbench acknowledgement omitted its result",
                )
            }),
            Some(false) => {
                let diagnostic = reply
                    .get("diagnostic")
                    .filter(|v| !v.is_null())
                    .map(|value| serde_json::from_value::<Diagnostic>(value.clone()))
                    .transpose()
                    .map_err(|_| {
                        transport_failure(
                            effectful,
                            Some(&request),
                            "Workbench returned an invalid diagnostic",
                        )
                    })?;
                Err(CliFailure {
                    message: reply
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Workbench rejected the request")
                        .into(),
                    diagnostic,
                })
            }
            None => Err(transport_failure(
                effectful,
                Some(&request),
                "Workbench response omitted its acknowledgement status",
            )),
        }
    }
}
async fn read_json(
    mut response: reqwest::Response,
    token: &str,
    effectful: bool,
    request: Option<&Value>,
) -> Result<(reqwest::StatusCode, Value), CliFailure> {
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > REPLY_BYTES as u64)
    {
        return Err(transport_failure(
            effectful,
            request,
            "Workbench reply exceeds the 8 MiB bound",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        transport_failure(
            effectful,
            request,
            "Workbench response body ended before confirmation",
        )
    })? {
        if bytes.len() + chunk.len() > REPLY_BYTES {
            return Err(transport_failure(
                effectful,
                request,
                "Workbench reply exceeds the 8 MiB bound",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        transport_failure(
            effectful,
            request,
            "Workbench returned an invalid JSON response",
        )
    })?;
    if contains_token(&value, token) {
        return Err(transport_failure(
            effectful,
            request,
            "Workbench response contained the private transport credential and was not printed",
        ));
    }
    Ok((status, value))
}
fn contains_token(value: &Value, token: &str) -> bool {
    match value {
        Value::String(s) => s.contains(token),
        Value::Array(values) => values.iter().any(|v| contains_token(v, token)),
        Value::Object(values) => values
            .iter()
            .any(|(k, v)| k.contains(token) || contains_token(v, token)),
        _ => false,
    }
}
fn invalid(message: &str) -> CliFailure {
    OperationError::InvalidInput(message.into()).into()
}
fn unavailable(message: &str) -> CliFailure {
    OperationError::Unavailable(message.into()).into()
}
fn transport_failure(effectful: bool, request: Option<&Value>, message: &str) -> CliFailure {
    if !effectful {
        return unavailable(message);
    }
    let mut reads = vec![];
    if let Some(request) = request {
        let params = &request["params"];
        match request["method"].as_str() {
            Some("invoke") if params["client_request_id"].is_string()=>reads.push(NextRead::query("operation.list_recent","Find the original request before deciding on any further action",json!({"client_request_id":params["client_request_id"],"limit":20}))),
            Some("application_control")=>reads.push(NextRead::query("application.command_status","Inspect the original application receipt",json!({"window":params["window"],"request_id":params["request_id"]}))),
            Some("bind_method")=>reads.push(NextRead::query("host.resolve_context","Inspect the method binding version",json!({"working_directory":params["binding"]["working_directory"],"external_task_ref":params["binding"]["external_task_ref"]}))),
            Some("reconcile_commit") if params["reference"]["operation_id"].is_string()=>reads.push(NextRead::query("operation.commit_status","Inspect the original commit receipt",json!({"operation_id":params["reference"]["operation_id"]}))),
            Some("request_cancellation")|Some("respond_input") if params["operation_id"].is_string()=>reads.push(NextRead::query("operation.get","Inspect the original scientific operation",json!({"operation_id":params["operation_id"]}))),
            _=>{},
        }
    }
    let message = format!(
        "{message}. The original request may have been accepted; inspect its existing receipt or operation instead of replaying it."
    );
    CliFailure {
        message: message.clone(),
        diagnostic: Some(Diagnostic {
            code: DiagnosticCode::OutcomeUncertain,
            message,
            continuation: DiagnosticContinuation::InspectOriginal,
            next_reads: reads,
        }),
    }
}
