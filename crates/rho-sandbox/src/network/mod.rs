use std::{
    collections::{BTreeMap, BTreeSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};

use rho_protocol::{DataClass, TurnId};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_NETWORK_REQUESTS: u32 = 32;
pub const MAX_NETWORK_REDIRECTS: usize = 5;
pub const MAX_NETWORK_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_NETWORK_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CanonicalDestination {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub path_and_query: String,
}

impl CanonicalDestination {
    pub fn origin(&self) -> String {
        format!("{}://{}:{}", self.scheme, self.host, self.port)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum NetworkAccessMode {
    Deny,
    ProviderOnly { configured_origin: String },
    Allowlisted { domains: BTreeSet<String> },
    UnrestrictedWithApproval,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnrestrictedNetworkApproval {
    pub approval_id: String,
    pub turn_id: TurnId,
    pub destination_origin: String,
    pub data_class: DataClass,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkRequest {
    pub turn_id: TurnId,
    pub url: String,
    pub data_class: DataClass,
    pub mode: NetworkAccessMode,
    pub approval: Option<UnrestrictedNetworkApproval>,
    pub now_ms: u64,
    pub response_byte_limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrokeredNetworkResponse {
    pub final_destination: CanonicalDestination,
    pub status: u16,
    pub body: Vec<u8>,
    pub redirects_followed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectorResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub redirect_location: Option<String>,
}

pub trait DnsResolver {
    fn resolve(&mut self, host: &str) -> Result<Vec<IpAddr>, NetworkEnforcementError>;
}

pub trait NetworkConnector {
    fn connect(
        &mut self,
        destination: &CanonicalDestination,
        pinned_ip: IpAddr,
    ) -> Result<ConnectorResponse, NetworkEnforcementError>;
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum NetworkEnforcementError {
    #[error("sandbox network is denied")]
    Denied,
    #[error("network platform enforcement is unavailable; deny remains active")]
    EnforcementUnavailable,
    #[error("destination URL is malformed or uses a forbidden scheme/userinfo/proxy")]
    InvalidDestination,
    #[error("destination is not the configured Provider origin")]
    ProviderOnlyViolation,
    #[error("destination is not allowlisted")]
    NotAllowlisted,
    #[error(
        "destination resolves to localhost, metadata, private, link-local, multicast, or unspecified address"
    )]
    ForbiddenAddress,
    #[error("DNS rebinding detected")]
    DnsRebinding,
    #[error(
        "unrestricted approval is missing, stale, reused, or bound to another turn/data/destination"
    )]
    InvalidApproval,
    #[error("network request/redirect/byte quota exceeded")]
    QuotaExceeded,
    #[error("network resolution failed")]
    ResolutionFailed,
    #[error("network connector failed")]
    ConnectorFailed,
}

#[derive(Debug)]
pub struct NetworkEnforcer {
    platform_enforcement_available: bool,
    used_approvals: BTreeSet<String>,
    requests: u32,
    total_bytes: u64,
}

impl NetworkEnforcer {
    pub fn new(platform_enforcement_available: bool) -> Self {
        Self {
            platform_enforcement_available,
            used_approvals: BTreeSet::new(),
            requests: 0,
            total_bytes: 0,
        }
    }

    pub fn execute(
        &mut self,
        request: &NetworkRequest,
        resolver: &mut impl DnsResolver,
        connector: &mut impl NetworkConnector,
    ) -> Result<BrokeredNetworkResponse, NetworkEnforcementError> {
        if !self.platform_enforcement_available {
            return Err(NetworkEnforcementError::EnforcementUnavailable);
        }
        if self.requests >= MAX_NETWORK_REQUESTS {
            return Err(NetworkEnforcementError::QuotaExceeded);
        }
        let mut destination = parse_destination(&request.url)?;
        self.authorize(request, &destination, true)?;
        let mut redirects_followed = 0;
        loop {
            let pinned_ip = resolve_and_pin(&destination, resolver)?;
            let connect_resolution = resolver.resolve(&destination.host)?;
            validate_resolution(&connect_resolution)?;
            if !connect_resolution.contains(&pinned_ip) {
                return Err(NetworkEnforcementError::DnsRebinding);
            }
            self.requests += 1;
            let response = connector.connect(&destination, pinned_ip)?;
            if response.body.len() > request.response_byte_limit.min(MAX_NETWORK_RESPONSE_BYTES) {
                return Err(NetworkEnforcementError::QuotaExceeded);
            }
            self.total_bytes = self.total_bytes.saturating_add(response.body.len() as u64);
            if self.total_bytes > MAX_NETWORK_TOTAL_BYTES {
                return Err(NetworkEnforcementError::QuotaExceeded);
            }
            if let Some(location) = response.redirect_location {
                if redirects_followed >= MAX_NETWORK_REDIRECTS {
                    return Err(NetworkEnforcementError::QuotaExceeded);
                }
                let redirected = parse_redirect(&destination, &location)?;
                self.authorize(request, &redirected, false)?;
                destination = redirected;
                redirects_followed += 1;
                continue;
            }
            return Ok(BrokeredNetworkResponse {
                final_destination: destination,
                status: response.status,
                body: response.body,
                redirects_followed,
            });
        }
    }

    fn authorize(
        &mut self,
        request: &NetworkRequest,
        destination: &CanonicalDestination,
        consume_approval: bool,
    ) -> Result<(), NetworkEnforcementError> {
        match &request.mode {
            NetworkAccessMode::Deny => Err(NetworkEnforcementError::Denied),
            NetworkAccessMode::ProviderOnly { configured_origin } => {
                if canonical_origin(configured_origin)? == destination.origin() {
                    Ok(())
                } else {
                    Err(NetworkEnforcementError::ProviderOnlyViolation)
                }
            }
            NetworkAccessMode::Allowlisted { domains } => {
                if domains
                    .iter()
                    .any(|allowed| domain_matches(&destination.host, allowed))
                {
                    Ok(())
                } else {
                    Err(NetworkEnforcementError::NotAllowlisted)
                }
            }
            NetworkAccessMode::UnrestrictedWithApproval => {
                let approval = request
                    .approval
                    .as_ref()
                    .ok_or(NetworkEnforcementError::InvalidApproval)?;
                if approval.turn_id != request.turn_id
                    || approval.destination_origin != destination.origin()
                    || approval.data_class != request.data_class
                    || request.now_ms > approval.expires_at_ms
                    || (consume_approval && self.used_approvals.contains(&approval.approval_id))
                {
                    return Err(NetworkEnforcementError::InvalidApproval);
                }
                if consume_approval {
                    self.used_approvals.insert(approval.approval_id.clone());
                }
                Ok(())
            }
        }
    }
}

pub fn parse_destination(value: &str) -> Result<CanonicalDestination, NetworkEnforcementError> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err(NetworkEnforcementError::InvalidDestination);
    }
    let (scheme, remainder) = value
        .split_once("://")
        .ok_or(NetworkEnforcementError::InvalidDestination)?;
    if !scheme.eq_ignore_ascii_case("https") {
        return Err(NetworkEnforcementError::InvalidDestination);
    }
    let authority_end = remainder.find(['/', '?', '#']).unwrap_or(remainder.len());
    let authority = &remainder[..authority_end];
    if authority.is_empty() || authority.contains('@') || authority.contains('%') {
        return Err(NetworkEnforcementError::InvalidDestination);
    }
    let path_and_query = &remainder[authority_end..];
    if path_and_query.starts_with('#') || path_and_query.contains('#') {
        return Err(NetworkEnforcementError::InvalidDestination);
    }
    let (host, port) = parse_authority(authority)?;
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || host == "localhost" || host.ends_with(".localhost") {
        return Err(NetworkEnforcementError::ForbiddenAddress);
    }
    if let Ok(ip) = host.parse::<IpAddr>()
        && !is_public_ip(ip)
    {
        return Err(NetworkEnforcementError::ForbiddenAddress);
    }
    Ok(CanonicalDestination {
        scheme: "https".to_string(),
        host,
        port,
        path_and_query: if path_and_query.is_empty() {
            "/".to_string()
        } else {
            path_and_query.to_string()
        },
    })
}

fn parse_authority(authority: &str) -> Result<(&str, u16), NetworkEnforcementError> {
    if let Some(rest) = authority.strip_prefix('[') {
        let end = rest
            .find(']')
            .ok_or(NetworkEnforcementError::InvalidDestination)?;
        let host = &rest[..end];
        let suffix = &rest[end + 1..];
        let port = if suffix.is_empty() {
            443
        } else {
            suffix
                .strip_prefix(':')
                .ok_or(NetworkEnforcementError::InvalidDestination)?
                .parse()
                .map_err(|_| NetworkEnforcementError::InvalidDestination)?
        };
        return Ok((host, port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => Ok((
            host,
            port.parse()
                .map_err(|_| NetworkEnforcementError::InvalidDestination)?,
        )),
        _ => Ok((authority, 443)),
    }
}

fn parse_redirect(
    previous: &CanonicalDestination,
    location: &str,
) -> Result<CanonicalDestination, NetworkEnforcementError> {
    if location.starts_with('/') && !location.starts_with("//") {
        return Ok(CanonicalDestination {
            path_and_query: location.to_string(),
            ..previous.clone()
        });
    }
    parse_destination(location)
}

fn canonical_origin(value: &str) -> Result<String, NetworkEnforcementError> {
    parse_destination(value).map(|destination| destination.origin())
}

fn domain_matches(host: &str, allowed: &str) -> bool {
    let allowed = allowed.trim_end_matches('.').to_ascii_lowercase();
    if let Some(suffix) = allowed.strip_prefix("*.") {
        host != suffix && host.ends_with(&format!(".{suffix}"))
    } else {
        host == allowed
    }
}

fn resolve_and_pin(
    destination: &CanonicalDestination,
    resolver: &mut impl DnsResolver,
) -> Result<IpAddr, NetworkEnforcementError> {
    if let Ok(ip) = destination.host.parse::<IpAddr>() {
        if is_public_ip(ip) {
            return Ok(ip);
        }
        return Err(NetworkEnforcementError::ForbiddenAddress);
    }
    let addresses = resolver.resolve(&destination.host)?;
    validate_resolution(&addresses)?;
    addresses
        .into_iter()
        .min_by_key(IpAddr::to_string)
        .ok_or(NetworkEnforcementError::ResolutionFailed)
}

fn validate_resolution(addresses: &[IpAddr]) -> Result<(), NetworkEnforcementError> {
    if addresses.is_empty() {
        return Err(NetworkEnforcementError::ResolutionFailed);
    }
    if addresses.iter().any(|address| !is_public_ip(*address)) {
        return Err(NetworkEnforcementError::ForbiddenAddress);
    }
    Ok(())
}

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_unspecified()
        || octets[0] == 0
        || octets[0] >= 224
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
        || (octets[0] == 198 && octets[1] == 18)
        || (octets[0] == 198 && octets[1] == 19)
        || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
        || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113))
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

#[derive(Debug, Default)]
pub struct StaticResolver {
    pub answers: BTreeMap<String, Vec<IpAddr>>,
}

impl DnsResolver for StaticResolver {
    fn resolve(&mut self, host: &str) -> Result<Vec<IpAddr>, NetworkEnforcementError> {
        self.answers
            .get(host)
            .cloned()
            .ok_or(NetworkEnforcementError::ResolutionFailed)
    }
}

pub fn network_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "destination_parser",
            "dns_pin_recheck",
            "redirect_recheck",
            "quota",
            "platform_enforcement",
        ],
        &[
            "direct_socket",
            "implicit_proxy",
            "provider_channel_as_unrestricted",
            "deny_downgrade",
        ],
    )
}
