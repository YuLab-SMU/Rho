use rho_contract::{
    CallContext, CapabilityKind, CapabilityRef, HostCatalog, HostDescription, HostOverview,
    QueryRequest, QuerySnapshot, QueryStatus,
};
use rho_host::{NextHost, OperationError};
use serde_json::{Value, json};
use std::collections::BTreeSet;

async fn query(
    host: &NextHost,
    context: &CallContext,
    id: &str,
    arguments: Value,
) -> Result<QuerySnapshot, OperationError> {
    host.query_snapshot(
        context,
        QueryRequest {
            capability: CapabilityRef::new(id, 1).unwrap(),
            arguments,
        },
    )
    .await
}

#[tokio::test]
async fn project_discovery_is_bounded_permission_filtered_and_does_not_create_scientific_work() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let host = NextHost::open_project(dir.path().join("state/next.sqlite"), &project)
        .await
        .unwrap();
    let context = NextHost::local_context();
    let before = query(
        &host,
        &context,
        "operation.list_recent",
        json!({"limit": 20}),
    )
    .await
    .unwrap()
    .data;
    let observation = query(&host, &context, "host.overview", json!({}))
        .await
        .unwrap();
    assert_eq!(observation.status, QueryStatus::Ready);
    assert!(serde_json::to_vec(&observation).unwrap().len() <= rho_contract::SUMMARY_BYTES);
    let overview: HostOverview = serde_json::from_value(observation.data.unwrap()).unwrap();
    assert!(!overview.atomic_snapshot);
    for name in [
        "objects",
        "packages",
        "session",
        "application",
        "documents",
        "layout",
    ] {
        let module = overview
            .modules
            .iter()
            .find(|module| module.module == name)
            .unwrap();
        assert!(!module.available, "{name}");
        assert!(!module.reasons.is_empty());
    }
    assert!(
        overview
            .modules
            .iter()
            .find(|module| module.module == "files")
            .unwrap()
            .available
    );
    assert!(
        !host
            .capabilities()
            .iter()
            .any(|d| d.capability.id == "workspace.run_r")
    );
    let mut reader = context.clone();
    reader.scopes = BTreeSet::from(["project.read".into()]);
    let expected: BTreeSet<_> = host
        .capabilities()
        .iter()
        .filter(|d| d.required_scopes.is_subset(&reader.scopes))
        .map(|d| d.capability.clone())
        .collect();
    let mut actual = BTreeSet::new();
    let mut arguments = json!({"limit": 2});
    let mut first_cursor = None;
    loop {
        let snapshot = query(&host, &reader, "host.catalog", arguments.clone())
            .await
            .unwrap();
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= rho_contract::CATALOG_BYTES);
        let page: HostCatalog = serde_json::from_value(snapshot.data.unwrap()).unwrap();
        assert_eq!(page.total as usize, expected.len());
        assert!(page.entries.len() <= 2);
        for entry in page.entries {
            assert!(actual.insert(entry.capability));
        }
        match page.next_cursor {
            Some(cursor) => {
                first_cursor.get_or_insert(cursor.clone());
                assert_eq!(snapshot.next_reads.len(), 1);
                assert_eq!(snapshot.next_reads[0].arguments["cursor"], cursor);
                arguments["cursor"] = json!(cursor);
            }
            None => break,
        }
    }
    assert_eq!(actual, expected);
    let cursor = first_cursor.unwrap();
    assert!(matches!(
        query(
            &host,
            &context,
            "host.catalog",
            json!({"cursor":cursor,"limit":2})
        )
        .await,
        Err(OperationError::ObservationExpired(_))
    ));
    assert!(matches!(
        query(
            &host,
            &reader,
            "host.describe",
            json!({"capability":{"id":"project.apply_patch","version":1}})
        )
        .await,
        Err(OperationError::NotFound(_))
    ));
    assert_eq!(
        query(
            &host,
            &context,
            "operation.list_recent",
            json!({"limit": 20})
        )
        .await
        .unwrap()
        .data,
        before
    );
}

#[tokio::test]
async fn every_composed_capability_has_a_bounded_exact_description_and_read_navigation() {
    let dir = tempfile::tempdir().unwrap();
    let host = NextHost::open_demo(dir.path().join("state.sqlite"))
        .await
        .unwrap();
    let context = NextHost::local_context();
    let descriptors = host.capabilities();
    for descriptor in &descriptors {
        let snapshot = query(
            &host,
            &context,
            "host.describe",
            json!({"capability":descriptor.capability}),
        )
        .await
        .unwrap();
        assert!(
            serde_json::to_vec(&snapshot).unwrap().len() <= rho_contract::DESCRIPTION_BYTES,
            "{}",
            descriptor.capability.id
        );
        let HostDescription::Capability {
            descriptor: described,
        } = serde_json::from_value(snapshot.data.unwrap()).unwrap()
        else {
            panic!("expected capability");
        };
        assert_eq!(*described, *descriptor);
        assert!(!described.documentation.examples.is_empty());
        assert_ne!(described.output_schema, json!({}));
        for example in &described.documentation.examples {
            assert!(!example.result_explanation.is_empty());
        }
        for reference in &described.documentation.related_capabilities {
            assert!(
                descriptors
                    .iter()
                    .any(|candidate| &candidate.capability == reference)
            );
        }
    }
    let snapshot = query(&host, &context, "host.overview", json!({}))
        .await
        .unwrap();
    for read in snapshot.next_reads {
        assert!(
            descriptors
                .iter()
                .any(|d| d.capability == read.capability && d.kind == CapabilityKind::Query)
        );
    }
    assert!(
        query(&host, &context, "host.catalog", json!({"limit":51}))
            .await
            .is_err()
    );
}
