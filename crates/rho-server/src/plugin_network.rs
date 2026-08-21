//! Credential-free, public-HTTPS-only network fetches for workspace plugins.

use std::collections::BTreeMap;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_PLUGIN_NETWORK_URL_BYTES: usize = 2048;
pub const MAX_PLUGIN_NETWORK_RESPONSE_BYTES: u64 = 1024 * 1024;
pub const MAX_PLUGIN_NETWORK_REDIRECTS: usize = 3;
pub const PLUGIN_NETWORK_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkFetchRequest {
    pub url: String,
    pub method: String,
    pub max_response_bytes: u64,
    pub expected_project_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkFetchPolicy {
    pub allowed_hosts: Vec<String>,
    pub allowed_methods: Vec<String>,
    pub max_response_bytes: u64,
    pub current_project_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkHop {
    pub url: String,
    pub origin: String,
    pub host: String,
    pub method: String,
    pub addresses: Vec<IpAddr>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkHopAuthorization {
    pub scheme: String,
    pub host: String,
    pub method: String,
    pub requested_response_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkTransportResponse {
    pub status: u16,
    pub safe_headers: BTreeMap<String, String>,
    pub location: Option<String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkFetchResult {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub final_origin: String,
    pub content_type: Option<String>,
    pub content_encoding: String,
    pub content: String,
    pub size_bytes: u64,
    pub truncated: bool,
    pub redirect_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkFetchErrorCode {
    InvalidUrl,
    HostNotAllowed,
    MethodNotAllowed,
    StaleProject,
    DnsFailed,
    NonPublicAddress,
    AuthorizationDenied,
    RedirectMissingLocation,
    TooManyRedirects,
    ResponseTooLarge,
    Timeout,
    TransportFailed,
}

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[error("plugin network fetch failed: {code:?}")]
pub struct NetworkFetchError {
    pub code: NetworkFetchErrorCode,
    pub completion_uncertain: bool,
}

impl NetworkFetchError {
    pub fn new(code: NetworkFetchErrorCode) -> Self {
        Self {
            code,
            completion_uncertain: false,
        }
    }

    fn with_uncertain(mut self, uncertain: bool) -> Self {
        self.completion_uncertain |= uncertain;
        self
    }
}

pub trait NetworkResolver: Send + Sync {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<IpAddr>, NetworkFetchError>> + Send + 'a>>;
}

pub trait NetworkTransport: Send + Sync {
    fn send<'a>(
        &'a self,
        hop: &'a NetworkHop,
        maximum_bytes: u64,
    ) -> Pin<
        Box<dyn Future<Output = Result<NetworkTransportResponse, NetworkFetchError>> + Send + 'a>,
    >;
}

pub trait NetworkAuthorizer: Send + Sync {
    fn authorize(&self, hop: &NetworkHopAuthorization) -> Result<(), NetworkFetchError>;
}

#[derive(Debug, Default)]
pub struct TokioNetworkResolver;

impl NetworkResolver for TokioNetworkResolver {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<IpAddr>, NetworkFetchError>> + Send + 'a>> {
        Box::pin(async move {
            let mut addresses = tokio::net::lookup_host((host, 443))
                .await
                .map_err(|_| NetworkFetchError::new(NetworkFetchErrorCode::DnsFailed))?
                .map(|address| address.ip())
                .collect::<Vec<_>>();
            addresses.sort();
            addresses.dedup();
            if addresses.is_empty() {
                return Err(NetworkFetchError::new(NetworkFetchErrorCode::DnsFailed));
            }
            Ok(addresses)
        })
    }
}

#[derive(Debug, Default)]
pub struct ReqwestNetworkTransport;

impl NetworkTransport for ReqwestNetworkTransport {
    fn send<'a>(
        &'a self,
        hop: &'a NetworkHop,
        maximum_bytes: u64,
    ) -> Pin<
        Box<dyn Future<Output = Result<NetworkTransportResponse, NetworkFetchError>> + Send + 'a>,
    > {
        Box::pin(async move {
            let socket_addresses = hop
                .addresses
                .iter()
                .copied()
                .map(|address| SocketAddr::new(address, 443))
                .collect::<Vec<_>>();
            let client = reqwest::Client::builder()
                .https_only(true)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .referer(false)
                .connect_timeout(PLUGIN_NETWORK_TIMEOUT)
                .timeout(PLUGIN_NETWORK_TIMEOUT)
                .user_agent("Rho-Workspace-Plugin/0.1")
                .resolve_to_addrs(&hop.host, &socket_addresses)
                .build()
                .map_err(|_| NetworkFetchError::new(NetworkFetchErrorCode::TransportFailed))?;
            let method = Method::from_bytes(hop.method.as_bytes())
                .map_err(|_| NetworkFetchError::new(NetworkFetchErrorCode::MethodNotAllowed))?;
            let mut response = client
                .request(method, &hop.url)
                .send()
                .await
                .map_err(classify_reqwest_error)?;
            let status = response.status();
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .map(|value| {
                    value
                        .to_str()
                        .map(str::to_string)
                        .map_err(|_| NetworkFetchError::new(NetworkFetchErrorCode::InvalidUrl))
                })
                .transpose()?;
            let safe_headers = safe_response_headers(response.headers())?;
            if is_redirect(status) {
                return Ok(NetworkTransportResponse {
                    status: status.as_u16(),
                    safe_headers,
                    location,
                    body: Vec::new(),
                });
            }
            let mut body = Vec::with_capacity(maximum_bytes.min(64 * 1024) as usize);
            while let Some(chunk) = response.chunk().await.map_err(classify_reqwest_error)? {
                if body.len().saturating_add(chunk.len()) as u64 > maximum_bytes {
                    return Err(NetworkFetchError::new(
                        NetworkFetchErrorCode::ResponseTooLarge,
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(NetworkTransportResponse {
                status: status.as_u16(),
                safe_headers,
                location,
                body,
            })
        })
    }
}

pub struct NetworkFetchEngine {
    resolver: Arc<dyn NetworkResolver>,
    transport: Arc<dyn NetworkTransport>,
    timeout: Duration,
}

impl std::fmt::Debug for NetworkFetchEngine {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NetworkFetchEngine")
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

impl Default for NetworkFetchEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl NetworkFetchEngine {
    pub fn new() -> Self {
        Self::with_parts(
            Arc::new(TokioNetworkResolver),
            Arc::new(ReqwestNetworkTransport),
            PLUGIN_NETWORK_TIMEOUT,
        )
    }

    pub fn with_parts(
        resolver: Arc<dyn NetworkResolver>,
        transport: Arc<dyn NetworkTransport>,
        timeout: Duration,
    ) -> Self {
        Self {
            resolver,
            transport,
            timeout,
        }
    }

    pub async fn fetch(
        &self,
        request: &NetworkFetchRequest,
        policy: &NetworkFetchPolicy,
        authorizer: &dyn NetworkAuthorizer,
    ) -> Result<NetworkFetchResult, NetworkFetchError> {
        let dispatched = AtomicBool::new(false);
        match tokio::time::timeout(
            self.timeout,
            self.fetch_inner(request, policy, authorizer, &dispatched),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(NetworkFetchError::new(NetworkFetchErrorCode::Timeout)
                .with_uncertain(dispatched.load(Ordering::SeqCst))),
        }
    }

    async fn fetch_inner(
        &self,
        request: &NetworkFetchRequest,
        policy: &NetworkFetchPolicy,
        authorizer: &dyn NetworkAuthorizer,
        dispatched: &AtomicBool,
    ) -> Result<NetworkFetchResult, NetworkFetchError> {
        network_request_authorization(request, policy)?;

        let mut current = request.url.clone();
        let mut redirects = 0;
        loop {
            let (url, host, origin) = validate_url(&current, &policy.allowed_hosts)
                .map_err(|error| error.with_uncertain(dispatched.load(Ordering::SeqCst)))?;
            let authorization = NetworkHopAuthorization {
                scheme: "https".to_string(),
                host: host.clone(),
                method: request.method.clone(),
                requested_response_bytes: request.max_response_bytes,
            };
            authorizer
                .authorize(&authorization)
                .map_err(|error| error.with_uncertain(dispatched.load(Ordering::SeqCst)))?;
            let addresses = self
                .resolver
                .resolve(&host)
                .await
                .map_err(|error| error.with_uncertain(dispatched.load(Ordering::SeqCst)))?;
            if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(*address)) {
                return Err(
                    NetworkFetchError::new(NetworkFetchErrorCode::NonPublicAddress)
                        .with_uncertain(dispatched.load(Ordering::SeqCst)),
                );
            }
            authorizer
                .authorize(&authorization)
                .map_err(|error| error.with_uncertain(dispatched.load(Ordering::SeqCst)))?;
            let hop = NetworkHop {
                url: url.to_string(),
                origin,
                host,
                method: request.method.clone(),
                addresses,
            };
            dispatched.store(true, Ordering::SeqCst);
            let response = self
                .transport
                .send(&hop, request.max_response_bytes)
                .await
                .map_err(|error| error.with_uncertain(true))?;
            authorizer
                .authorize(&authorization)
                .map_err(|error| error.with_uncertain(true))?;
            let status = StatusCode::from_u16(response.status).map_err(|_| {
                NetworkFetchError::new(NetworkFetchErrorCode::TransportFailed).with_uncertain(true)
            })?;
            if is_redirect(status) {
                if redirects >= MAX_PLUGIN_NETWORK_REDIRECTS {
                    return Err(
                        NetworkFetchError::new(NetworkFetchErrorCode::TooManyRedirects)
                            .with_uncertain(true),
                    );
                }
                let location = response.location.ok_or_else(|| {
                    NetworkFetchError::new(NetworkFetchErrorCode::RedirectMissingLocation)
                        .with_uncertain(true)
                })?;
                if location.len() > MAX_PLUGIN_NETWORK_URL_BYTES
                    || location.chars().any(char::is_control)
                {
                    return Err(NetworkFetchError::new(NetworkFetchErrorCode::InvalidUrl)
                        .with_uncertain(true));
                }
                current = url
                    .join(&location)
                    .map_err(|_| {
                        NetworkFetchError::new(NetworkFetchErrorCode::InvalidUrl)
                            .with_uncertain(true)
                    })?
                    .to_string();
                redirects += 1;
                continue;
            }
            if response.body.len() as u64 > request.max_response_bytes {
                return Err(
                    NetworkFetchError::new(NetworkFetchErrorCode::ResponseTooLarge)
                        .with_uncertain(true),
                );
            }
            let safe_headers = filter_safe_header_map(response.safe_headers)?;
            let content_type = safe_headers.get("content-type").cloned();
            return Ok(NetworkFetchResult {
                status: response.status,
                headers: safe_headers,
                final_origin: hop.origin,
                content_type,
                content_encoding: "base64".to_string(),
                content: BASE64_STANDARD.encode(&response.body),
                size_bytes: response.body.len() as u64,
                truncated: false,
                redirect_count: redirects,
            });
        }
    }
}

pub fn network_request_authorization(
    request: &NetworkFetchRequest,
    policy: &NetworkFetchPolicy,
) -> Result<NetworkHopAuthorization, NetworkFetchError> {
    if request.expected_project_revision != policy.current_project_revision {
        return Err(NetworkFetchError::new(NetworkFetchErrorCode::StaleProject));
    }
    if request.max_response_bytes == 0
        || request.max_response_bytes > policy.max_response_bytes
        || request.max_response_bytes > MAX_PLUGIN_NETWORK_RESPONSE_BYTES
    {
        return Err(NetworkFetchError::new(
            NetworkFetchErrorCode::ResponseTooLarge,
        ));
    }
    if !policy
        .allowed_methods
        .iter()
        .any(|method| method == &request.method)
        || !matches!(request.method.as_str(), "GET" | "HEAD")
    {
        return Err(NetworkFetchError::new(
            NetworkFetchErrorCode::MethodNotAllowed,
        ));
    }
    let (_, host, _) = validate_url(&request.url, &policy.allowed_hosts)?;
    Ok(NetworkHopAuthorization {
        scheme: "https".to_string(),
        host,
        method: request.method.clone(),
        requested_response_bytes: request.max_response_bytes,
    })
}

fn validate_url(
    url: &str,
    allowed_hosts: &[String],
) -> Result<(Url, String, String), NetworkFetchError> {
    if url.is_empty()
        || url.len() > MAX_PLUGIN_NETWORK_URL_BYTES
        || url.chars().any(char::is_control)
    {
        return Err(NetworkFetchError::new(NetworkFetchErrorCode::InvalidUrl));
    }
    let parsed =
        Url::parse(url).map_err(|_| NetworkFetchError::new(NetworkFetchErrorCode::InvalidUrl))?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || parsed.port_or_known_default() != Some(443)
    {
        return Err(NetworkFetchError::new(NetworkFetchErrorCode::InvalidUrl));
    }
    let host = parsed
        .host_str()
        .filter(|host| !host.ends_with('.'))
        .filter(|host| IpAddr::from_str(host).is_err())
        .filter(|host| valid_host(host))
        .ok_or_else(|| NetworkFetchError::new(NetworkFetchErrorCode::InvalidUrl))?
        .to_ascii_lowercase();
    if !allowed_hosts
        .iter()
        .any(|allowed| host_matches(allowed, &host))
    {
        return Err(NetworkFetchError::new(
            NetworkFetchErrorCode::HostNotAllowed,
        ));
    }
    let origin = format!("https://{host}");
    Ok((parsed, host, origin))
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && host.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

fn host_matches(pattern: &str, host: &str) -> bool {
    if !valid_host(pattern.strip_prefix("*.").unwrap_or(pattern)) || !valid_host(host) {
        return false;
    }
    match pattern.strip_prefix("*.") {
        Some(suffix) => {
            host.len() > suffix.len()
                && host.ends_with(suffix)
                && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
        }
        None => pattern == host,
    }
}

pub fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || (224..=255).contains(&a))
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    if address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || address.to_ipv4_mapped().is_some()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || segments[0] == 0x2002
        || (segments[0] == 0x2001 && segments[1] <= 0x01ff)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] == 0x2001 && segments[1] == 0x0002)
        || (segments[0] == 0x3fff && (segments[1] & 0xfff0) == 0)
    {
        return false;
    }
    (segments[0] & 0xe000) == 0x2000
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

fn safe_response_headers(
    headers: &reqwest::header::HeaderMap,
) -> Result<BTreeMap<String, String>, NetworkFetchError> {
    let mut safe = BTreeMap::new();
    for name in ["content-type", "content-length", "etag", "last-modified"] {
        if let Some(value) = headers.get(name) {
            let value = value
                .to_str()
                .map_err(|_| NetworkFetchError::new(NetworkFetchErrorCode::TransportFailed))?;
            if value.len() > 8192 || value.chars().any(char::is_control) {
                return Err(NetworkFetchError::new(
                    NetworkFetchErrorCode::TransportFailed,
                ));
            }
            safe.insert(name.to_string(), value.to_string());
        }
    }
    Ok(safe)
}

fn filter_safe_header_map(
    headers: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, NetworkFetchError> {
    let mut safe = BTreeMap::new();
    for name in ["content-type", "content-length", "etag", "last-modified"] {
        if let Some(value) = headers.get(name) {
            if value.len() > 8192 || value.chars().any(char::is_control) {
                return Err(
                    NetworkFetchError::new(NetworkFetchErrorCode::TransportFailed)
                        .with_uncertain(true),
                );
            }
            safe.insert(name.to_string(), value.clone());
        }
    }
    Ok(safe)
}

fn classify_reqwest_error(error: reqwest::Error) -> NetworkFetchError {
    if error.is_timeout() {
        NetworkFetchError::new(NetworkFetchErrorCode::Timeout)
    } else {
        NetworkFetchError::new(NetworkFetchErrorCode::TransportFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, VecDeque};
    use std::sync::Mutex;

    struct Resolver(Mutex<BTreeMap<String, VecDeque<Vec<IpAddr>>>>);
    impl NetworkResolver for Resolver {
        fn resolve<'a>(
            &'a self,
            host: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<IpAddr>, NetworkFetchError>> + Send + 'a>>
        {
            Box::pin(async move {
                self.0
                    .lock()
                    .unwrap()
                    .get_mut(host)
                    .and_then(VecDeque::pop_front)
                    .ok_or_else(|| NetworkFetchError::new(NetworkFetchErrorCode::DnsFailed))
            })
        }
    }

    struct Transport {
        responses: Mutex<VecDeque<NetworkTransportResponse>>,
        delay: Duration,
        hops: Mutex<Vec<NetworkHop>>,
    }
    impl NetworkTransport for Transport {
        fn send<'a>(
            &'a self,
            hop: &'a NetworkHop,
            _maximum_bytes: u64,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<NetworkTransportResponse, NetworkFetchError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                self.hops.lock().unwrap().push(hop.clone());
                tokio::time::sleep(self.delay).await;
                self.responses
                    .lock()
                    .unwrap()
                    .pop_front()
                    .ok_or_else(|| NetworkFetchError::new(NetworkFetchErrorCode::TransportFailed))
            })
        }
    }

    struct Authorizer {
        calls: std::sync::atomic::AtomicUsize,
        deny_at: Option<usize>,
    }
    impl NetworkAuthorizer for Authorizer {
        fn authorize(&self, _hop: &NetworkHopAuthorization) -> Result<(), NetworkFetchError> {
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if self.deny_at == Some(call) {
                Err(NetworkFetchError::new(
                    NetworkFetchErrorCode::AuthorizationDenied,
                ))
            } else {
                Ok(())
            }
        }
    }

    fn policy(hosts: &[&str]) -> NetworkFetchPolicy {
        NetworkFetchPolicy {
            allowed_hosts: hosts.iter().map(|host| host.to_string()).collect(),
            allowed_methods: vec!["GET".to_string(), "HEAD".to_string()],
            max_response_bytes: 1024,
            current_project_revision: 7,
        }
    }

    fn request(url: &str) -> NetworkFetchRequest {
        NetworkFetchRequest {
            url: url.to_string(),
            method: "GET".to_string(),
            max_response_bytes: 16,
            expected_project_revision: 7,
        }
    }

    fn resolver(entries: &[(&str, Vec<Vec<IpAddr>>)]) -> Arc<Resolver> {
        Arc::new(Resolver(Mutex::new(
            entries
                .iter()
                .map(|(host, values)| (host.to_string(), values.clone().into()))
                .collect(),
        )))
    }

    fn response(status: u16, location: Option<&str>, body: &[u8]) -> NetworkTransportResponse {
        NetworkTransportResponse {
            status,
            safe_headers: BTreeMap::from([
                ("content-type".to_string(), "text/plain".to_string()),
                ("set-cookie".to_string(), "secret=never".to_string()),
                ("server".to_string(), "internal-version".to_string()),
                ("authorization".to_string(), "Bearer secret".to_string()),
            ]),
            location: location.map(str::to_string),
            body: body.to_vec(),
        }
    }

    #[tokio::test]
    async fn fetches_public_https_and_filters_to_bounded_data() {
        let rebound_resolver = resolver(&[(
            "api.example.org",
            vec![vec!["93.184.216.34".parse().unwrap()]],
        )]);
        let transport = Arc::new(Transport {
            responses: Mutex::new(vec![response(200, None, b"hello")].into()),
            delay: Duration::ZERO,
            hops: Mutex::new(Vec::new()),
        });
        let engine = NetworkFetchEngine::with_parts(
            rebound_resolver,
            transport.clone(),
            Duration::from_secs(1),
        );
        let authorizer = Authorizer {
            calls: Default::default(),
            deny_at: None,
        };
        let result = engine
            .fetch(
                &request("https://api.example.org/data?q=1"),
                &policy(&["api.example.org"]),
                &authorizer,
            )
            .await
            .unwrap();
        assert_eq!(result.content, "aGVsbG8=");
        assert_eq!(result.final_origin, "https://api.example.org");
        assert!(!result.truncated);
        assert_eq!(
            result.headers.keys().cloned().collect::<Vec<_>>(),
            vec!["content-type"]
        );
        assert!(!serde_json::to_string(&result).unwrap().contains("secret"));
        assert_eq!(transport.hops.lock().unwrap()[0].addresses.len(), 1);
    }

    #[tokio::test]
    async fn rejects_url_method_host_and_wildcard_confusion_before_transport() {
        let invalid = [
            "http://api.example.org/x",
            "https://user@api.example.org/x",
            "https://api.example.org:8443/x",
            "https://127.0.0.1/x",
            "https://api.example.org./x",
            "https://api.example.org/x#fragment",
        ];
        let resolver = resolver(&[]);
        let transport = Arc::new(Transport {
            responses: Mutex::new(VecDeque::new()),
            delay: Duration::ZERO,
            hops: Mutex::new(Vec::new()),
        });
        let engine =
            NetworkFetchEngine::with_parts(resolver, transport.clone(), Duration::from_secs(1));
        let authorizer = Authorizer {
            calls: Default::default(),
            deny_at: None,
        };
        for url in invalid {
            let error = engine
                .fetch(&request(url), &policy(&["api.example.org"]), &authorizer)
                .await
                .unwrap_err();
            assert!(!error.completion_uncertain);
        }
        assert_eq!(
            engine
                .fetch(
                    &request("https://example.org/x"),
                    &policy(&["*.example.org"]),
                    &authorizer
                )
                .await
                .unwrap_err()
                .code,
            NetworkFetchErrorCode::HostNotAllowed
        );
        assert_eq!(
            engine
                .fetch(
                    &request("https://evil-example.org/x"),
                    &policy(&["*.example.org"]),
                    &authorizer
                )
                .await
                .unwrap_err()
                .code,
            NetworkFetchErrorCode::HostNotAllowed
        );
        assert!(transport.hops.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn rejects_mixed_private_dns_rebinding_and_special_ranges() {
        let foreign_resolver = resolver(&[(
            "api.example.org",
            vec![
                vec![
                    "93.184.216.34".parse().unwrap(),
                    "127.0.0.1".parse().unwrap(),
                ],
                vec!["93.184.216.34".parse().unwrap()],
                vec!["10.0.0.1".parse().unwrap()],
            ],
        )]);
        let transport = Arc::new(Transport {
            responses: Mutex::new(vec![response(302, Some("/next"), b"")].into()),
            delay: Duration::ZERO,
            hops: Mutex::new(Vec::new()),
        });
        let engine =
            NetworkFetchEngine::with_parts(foreign_resolver, transport, Duration::from_secs(1));
        let authorizer = Authorizer {
            calls: Default::default(),
            deny_at: None,
        };
        assert_eq!(
            engine
                .fetch(
                    &request("https://api.example.org/x"),
                    &policy(&["api.example.org"]),
                    &authorizer
                )
                .await
                .unwrap_err()
                .code,
            NetworkFetchErrorCode::NonPublicAddress
        );
        for address in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.1.1",
            "192.0.2.1",
            "192.88.99.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2001::1",
            "2002:7f00:1::",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(is_public_ip("93.184.216.34".parse().unwrap()));
        assert!(is_public_ip(
            "2606:2800:220:1:248:1893:25c8:1946".parse().unwrap()
        ));
    }

    #[tokio::test]
    async fn redirects_revalidate_dns_and_authority_and_enforce_bounds_timeout() {
        let redirect_resolver = resolver(&[
            (
                "api.example.org",
                vec![vec!["93.184.216.34".parse().unwrap()]],
            ),
            (
                "cdn.example.org",
                vec![vec!["93.184.216.35".parse().unwrap()]],
            ),
        ]);
        let transport = Arc::new(Transport {
            responses: Mutex::new(
                vec![
                    response(302, Some("https://cdn.example.org/data"), b""),
                    response(200, None, b"0123456789abcdefg"),
                ]
                .into(),
            ),
            delay: Duration::ZERO,
            hops: Mutex::new(Vec::new()),
        });
        let engine =
            NetworkFetchEngine::with_parts(redirect_resolver, transport, Duration::from_secs(1));
        let authorizer = Authorizer {
            calls: Default::default(),
            deny_at: None,
        };
        let overflow = engine
            .fetch(
                &request("https://api.example.org/x"),
                &policy(&["*.example.org"]),
                &authorizer,
            )
            .await
            .unwrap_err();
        assert_eq!(overflow.code, NetworkFetchErrorCode::ResponseTooLarge);
        assert!(overflow.completion_uncertain);

        let timeout_resolver = resolver(&[(
            "api.example.org",
            vec![vec!["93.184.216.34".parse().unwrap()]],
        )]);
        let transport = Arc::new(Transport {
            responses: Mutex::new(vec![response(200, None, b"ok")].into()),
            delay: Duration::from_millis(20),
            hops: Mutex::new(Vec::new()),
        });
        let engine =
            NetworkFetchEngine::with_parts(timeout_resolver, transport, Duration::from_millis(1));
        let timeout = engine
            .fetch(
                &request("https://api.example.org/x"),
                &policy(&["api.example.org"]),
                &authorizer,
            )
            .await
            .unwrap_err();
        assert_eq!(timeout.code, NetworkFetchErrorCode::Timeout);
        assert!(timeout.completion_uncertain);
    }

    #[tokio::test]
    async fn idna_is_canonical_and_revoke_during_redirect_stops_before_second_hop() {
        let resolver = resolver(&[(
            "xn--bcher-kva.example",
            vec![vec!["93.184.216.34".parse().unwrap()]],
        )]);
        let transport = Arc::new(Transport {
            responses: Mutex::new(vec![response(302, Some("/next"), b"")].into()),
            delay: Duration::ZERO,
            hops: Mutex::new(Vec::new()),
        });
        let engine =
            NetworkFetchEngine::with_parts(resolver, transport.clone(), Duration::from_secs(1));
        let authorizer = Authorizer {
            calls: Default::default(),
            deny_at: Some(3),
        };
        let error = engine
            .fetch(
                &request("https://BÜCHER.example/x"),
                &policy(&["xn--bcher-kva.example"]),
                &authorizer,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, NetworkFetchErrorCode::AuthorizationDenied);
        assert!(error.completion_uncertain);
        assert_eq!(transport.hops.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn redirect_to_foreign_or_rebound_private_host_is_uncertain_and_stops() {
        let rebound_resolver = resolver(&[(
            "api.example.org",
            vec![
                vec!["93.184.216.34".parse().unwrap()],
                vec!["10.0.0.1".parse().unwrap()],
            ],
        )]);
        let transport = Arc::new(Transport {
            responses: Mutex::new(vec![response(302, Some("/again"), b"")].into()),
            delay: Duration::ZERO,
            hops: Mutex::new(Vec::new()),
        });
        let engine = NetworkFetchEngine::with_parts(
            rebound_resolver,
            transport.clone(),
            Duration::from_secs(1),
        );
        let authorizer = Authorizer {
            calls: Default::default(),
            deny_at: None,
        };
        let error = engine
            .fetch(
                &request("https://api.example.org/x"),
                &policy(&["api.example.org"]),
                &authorizer,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, NetworkFetchErrorCode::NonPublicAddress);
        assert!(error.completion_uncertain);
        assert_eq!(transport.hops.lock().unwrap().len(), 1);

        let foreign_resolver = resolver(&[(
            "api.example.org",
            vec![vec!["93.184.216.34".parse().unwrap()]],
        )]);
        let transport = Arc::new(Transport {
            responses: Mutex::new(
                vec![response(302, Some("https://foreign.example.net/x"), b"")].into(),
            ),
            delay: Duration::ZERO,
            hops: Mutex::new(Vec::new()),
        });
        let engine =
            NetworkFetchEngine::with_parts(foreign_resolver, transport, Duration::from_secs(1));
        let error = engine
            .fetch(
                &request("https://api.example.org/x"),
                &policy(&["api.example.org"]),
                &authorizer,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, NetworkFetchErrorCode::HostNotAllowed);
        assert!(error.completion_uncertain);
    }

    #[tokio::test]
    async fn request_schema_and_redirect_count_fail_closed() {
        assert!(
            serde_json::from_value::<NetworkFetchRequest>(serde_json::json!({
                "url": "https://api.example.org/x",
                "method": "POST",
                "max_response_bytes": 16,
                "expected_project_revision": 7,
                "body": "forbidden",
                "headers": {"authorization": "forbidden"}
            }))
            .is_err()
        );
        let resolver = resolver(&[(
            "api.example.org",
            vec![
                vec!["93.184.216.34".parse().unwrap()],
                vec!["93.184.216.34".parse().unwrap()],
                vec!["93.184.216.34".parse().unwrap()],
                vec!["93.184.216.34".parse().unwrap()],
            ],
        )]);
        let transport = Arc::new(Transport {
            responses: Mutex::new((0..4).map(|_| response(302, Some("/next"), b"")).collect()),
            delay: Duration::ZERO,
            hops: Mutex::new(Vec::new()),
        });
        let engine =
            NetworkFetchEngine::with_parts(resolver, transport.clone(), Duration::from_secs(1));
        let authorizer = Authorizer {
            calls: Default::default(),
            deny_at: None,
        };
        let error = engine
            .fetch(
                &request("https://api.example.org/x"),
                &policy(&["api.example.org"]),
                &authorizer,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, NetworkFetchErrorCode::TooManyRedirects);
        assert!(error.completion_uncertain);
        assert_eq!(transport.hops.lock().unwrap().len(), 4);
    }
}
