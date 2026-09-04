use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    net::{IpAddr, Ipv4Addr},
};

use rho_protocol::{DataClass, TurnId};
use rho_sandbox::network::*;

#[derive(Default)]
struct FakeConnector {
    calls: usize,
    responses: VecDeque<ConnectorResponse>,
}

impl NetworkConnector for FakeConnector {
    fn connect(
        &mut self,
        _destination: &CanonicalDestination,
        _pinned_ip: IpAddr,
    ) -> Result<ConnectorResponse, NetworkEnforcementError> {
        self.calls += 1;
        self.responses
            .pop_front()
            .ok_or(NetworkEnforcementError::ConnectorFailed)
    }
}

struct SequenceResolver {
    answers: VecDeque<Vec<IpAddr>>,
}

impl DnsResolver for SequenceResolver {
    fn resolve(&mut self, _host: &str) -> Result<Vec<IpAddr>, NetworkEnforcementError> {
        self.answers
            .pop_front()
            .ok_or(NetworkEnforcementError::ResolutionFailed)
    }
}

fn public() -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))
}

fn request(url: &str, mode: NetworkAccessMode) -> NetworkRequest {
    NetworkRequest {
        turn_id: TurnId::new("turn_network").unwrap(),
        url: url.to_string(),
        data_class: DataClass::ProjectInternal,
        mode,
        response_byte_limit: 1024,
    }
}

fn resolver(host: &str) -> StaticResolver {
    StaticResolver {
        answers: BTreeMap::from([(host.to_string(), vec![public()])]),
    }
}

#[test]
fn network_default_deny_and_unavailable_enforcement_make_zero_connector_calls() {
    let mut denied = NetworkEnforcer::new(true);
    let mut resolver = resolver("example.org");
    let mut connector = FakeConnector::default();
    assert_eq!(
        denied
            .execute(
                &request("https://example.org/data", NetworkAccessMode::Deny),
                &mut resolver,
                &mut connector,
            )
            .unwrap_err(),
        NetworkEnforcementError::Denied
    );
    assert_eq!(connector.calls, 0);

    let mut unavailable = NetworkEnforcer::new(false);
    assert_eq!(
        unavailable
            .execute(
                &request(
                    "https://example.org/data",
                    NetworkAccessMode::Allowlisted {
                        domains: ["example.org".to_string()].into(),
                    },
                ),
                &mut resolver,
                &mut connector,
            )
            .unwrap_err(),
        NetworkEnforcementError::EnforcementUnavailable
    );
    assert_eq!(connector.calls, 0);
}

#[test]
fn network_parser_rejects_http_userinfo_localhost_metadata_private_and_proxy_shapes() {
    for bad in [
        "http://example.org",
        "https://user@example.org",
        "https://localhost",
        "https://127.0.0.1",
        "https://169.254.169.254/latest/meta-data",
        "https://10.0.0.1",
        "https://192.168.1.1",
        "https://[::1]",
        "https://example.org#fragment",
        "https://example.org%2fattacker.invalid",
    ] {
        assert!(
            parse_destination(bad).is_err(),
            "destination should fail: {bad}"
        );
    }
}

#[test]
fn network_provider_only_cannot_contact_arbitrary_domain() {
    let mode = NetworkAccessMode::ProviderOnly {
        configured_origin: "https://provider.example:443".to_string(),
    };
    let mut enforcer = NetworkEnforcer::new(true);
    let mut resolver = resolver("attacker.example");
    let mut connector = FakeConnector::default();
    assert_eq!(
        enforcer
            .execute(
                &request("https://attacker.example/exfil", mode),
                &mut resolver,
                &mut connector,
            )
            .unwrap_err(),
        NetworkEnforcementError::ProviderOnlyViolation
    );
    assert_eq!(connector.calls, 0);
}

#[test]
fn network_allowlist_checks_connect_and_every_redirect() {
    let mode = NetworkAccessMode::Allowlisted {
        domains: ["allowed.example".to_string()].into(),
    };
    let mut enforcer = NetworkEnforcer::new(true);
    let mut resolver = StaticResolver {
        answers: BTreeMap::from([
            ("allowed.example".to_string(), vec![public()]),
            ("attacker.example".to_string(), vec![public()]),
        ]),
    };
    let mut connector = FakeConnector {
        calls: 0,
        responses: [ConnectorResponse {
            status: 302,
            body: Vec::new(),
            redirect_location: Some("https://attacker.example/exfil".to_string()),
        }]
        .into(),
    };
    assert_eq!(
        enforcer
            .execute(
                &request("https://allowed.example/start", mode),
                &mut resolver,
                &mut connector,
            )
            .unwrap_err(),
        NetworkEnforcementError::NotAllowlisted
    );
    assert_eq!(
        connector.calls, 1,
        "redirect target must be denied before connection"
    );
}

#[test]
fn network_wildcard_allowlist_does_not_match_suffix_confusion() {
    let domains = BTreeSet::from(["*.example.org".to_string()]);
    let mut enforcer = NetworkEnforcer::new(true);
    let mut resolver = resolver("evil-example.org");
    let mut connector = FakeConnector::default();
    assert_eq!(
        enforcer
            .execute(
                &request(
                    "https://evil-example.org",
                    NetworkAccessMode::Allowlisted { domains },
                ),
                &mut resolver,
                &mut connector,
            )
            .unwrap_err(),
        NetworkEnforcementError::NotAllowlisted
    );
    assert_eq!(connector.calls, 0);
}

#[test]
fn network_dns_rebinding_is_detected_before_connector() {
    let mut enforcer = NetworkEnforcer::new(true);
    let mut resolver = SequenceResolver {
        answers: [vec![public()], vec![IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))]].into(),
    };
    let mut connector = FakeConnector::default();
    assert_eq!(
        enforcer
            .execute(
                &request(
                    "https://allowed.example",
                    NetworkAccessMode::Allowlisted {
                        domains: ["allowed.example".to_string()].into(),
                    },
                ),
                &mut resolver,
                &mut connector,
            )
            .unwrap_err(),
        NetworkEnforcementError::DnsRebinding
    );
    assert_eq!(connector.calls, 0);
}

#[test]
fn network_resolution_rejects_any_private_answer_before_packet() {
    let mut enforcer = NetworkEnforcer::new(true);
    let mut resolver = SequenceResolver {
        answers: [vec![public(), IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))]].into(),
    };
    let mut connector = FakeConnector::default();
    assert_eq!(
        enforcer
            .execute(
                &request(
                    "https://mixed.example",
                    NetworkAccessMode::Allowlisted {
                        domains: ["mixed.example".to_string()].into(),
                    },
                ),
                &mut resolver,
                &mut connector,
            )
            .unwrap_err(),
        NetworkEnforcementError::ForbiddenAddress
    );
    assert_eq!(connector.calls, 0);
}

#[test]
fn network_unrestricted_requires_no_rho_approval() {
    let mut exact = request(
        "https://target.example/data",
        NetworkAccessMode::Unrestricted,
    );
    exact.data_class = DataClass::ProjectConfidential;
    let mut enforcer = NetworkEnforcer::new(true);
    let mut first_resolver = resolver("target.example");
    let mut connector = FakeConnector {
        calls: 0,
        responses: [ConnectorResponse {
            status: 200,
            body: b"ok".to_vec(),
            redirect_location: None,
        }]
        .into(),
    };
    assert_eq!(
        enforcer
            .execute(&exact, &mut first_resolver, &mut connector)
            .unwrap()
            .body,
        b"ok"
    );
}

#[test]
fn network_response_and_request_quotas_are_bounded() {
    let mut enforcer = NetworkEnforcer::new(true);
    let mut connector = FakeConnector {
        calls: 0,
        responses: [ConnectorResponse {
            status: 200,
            body: vec![0; 2048],
            redirect_location: None,
        }]
        .into(),
    };
    assert_eq!(
        enforcer
            .execute(
                &request(
                    "https://allowed.example",
                    NetworkAccessMode::Allowlisted {
                        domains: ["allowed.example".to_string()].into(),
                    },
                ),
                &mut resolver("allowed.example"),
                &mut connector,
            )
            .unwrap_err(),
        NetworkEnforcementError::QuotaExceeded
    );
}

#[test]
fn network_boundary_has_no_direct_socket_proxy_or_deny_downgrade() {
    let (_, does_not_own) = network_boundary();
    assert!(does_not_own.contains(&"direct_socket"));
    assert!(does_not_own.contains(&"implicit_proxy"));
    assert!(does_not_own.contains(&"provider_channel_as_unrestricted"));
    assert!(does_not_own.contains(&"deny_downgrade"));
}
