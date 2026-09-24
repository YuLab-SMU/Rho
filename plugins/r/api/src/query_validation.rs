//! Shared bounded input validation for native R observations.
//! Both the ordinary R package and the retiring Host adapter use these rules.
use crate::*;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RQueryValidationError(String);
impl std::fmt::Display for RQueryValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for RQueryValidationError {}

#[derive(Clone, Copy)]
pub enum WorkspaceQueryKind {
    ReadHelp,
    Packages,
    Snapshot,
    InspectObject,
    ListObjects,
    ObserveObject,
    ReadObject,
    PackageIndex,
}

impl WorkspaceQueryKind {
    pub fn parse(&self, arguments: &Value) -> Result<WorkspaceQuery, RQueryValidationError> {
        let invalid = |e: serde_json::Error| RQueryValidationError(e.to_string());
        match self {
            WorkspaceQueryKind::ReadHelp => {
                let a: crate::ReadPackageHelpArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                validate_reference(Some(&a.observation_id))?;
                let files_ok = |files: &[crate::PackageFileIdentity]| {
                    files.len() == 4
                        && files
                            .iter()
                            .all(|f| f.path.len() <= 128 && f.digest.len() <= 32768)
                };
                if a.package.is_empty()
                    || a.package.len() > 128
                    || !a.package.starts_with(|c: char| c.is_ascii_alphabetic())
                    || !a
                        .package
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'.')
                    || a.library_path.is_empty()
                    || a.library_path.len() > 16384
                    || a.library_path.contains('\0')
                    || a.topic.trim().is_empty()
                    || a.topic.len() > 128
                    || a.topic.chars().any(char::is_control)
                    || !files_ok(&a.expected_index_files)
                    || a.expected_help_files.as_ref().is_some_and(|f| !files_ok(f))
                    || !(4..=32768).contains(&a.limit_bytes)
                    || a.offset_utf8 > 16 * 1024 * 1024
                    || (a.offset_utf8 > 0 && a.expected_help_files.is_none())
                {
                    return Err(RQueryValidationError("Help reading requires an observed package/index, bounded topic, 4..=32768 bytes and help identities for continuation".into()));
                }
                Ok(WorkspaceQuery::ReadHelp(ScopedWorkspaceArguments::unbound(
                    a,
                )))
            }
            WorkspaceQueryKind::ListObjects => {
                let a: ListObjectsArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                if a.limit == 0
                    || a.limit > 200
                    || a.name_contains.len() > 4096
                    || a.name_contains.contains('\0')
                    || a.object_type.as_ref().is_some_and(|v| v.len() > 64)
                    || (a.directory_ref.is_none() && a.offset != 0)
                {
                    return Err(RQueryValidationError("Object listing requires limit 1..=200, bounded filters, and a directory reference for continuation".into()));
                }
                validate_reference(a.directory_ref.as_deref())?;
                Ok(WorkspaceQuery::ListObjects(
                    ScopedWorkspaceArguments::unbound(a),
                ))
            }
            WorkspaceQueryKind::ObserveObject => {
                let a: ObserveObjectArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                if a.name.is_empty() || a.name.len() > 4096 || a.name.contains('\0') {
                    return Err(RQueryValidationError(
                        "Object name must contain 1..=4096 UTF-8 bytes without NUL".into(),
                    ));
                }
                validate_path(&a.path)?;
                Ok(WorkspaceQuery::ObserveObject(
                    ScopedWorkspaceArguments::unbound(a),
                ))
            }
            WorkspaceQueryKind::ReadObject => {
                let a: ReadObjectArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                validate_reference(Some(&a.object_ref))?;
                validate_path(&a.path)?;
                if a.start == 0
                    || a.start > 9007199254740991
                    || a.limit == 0
                    || a.limit > 200
                    || a.column_start == 0
                    || a.column_limit == 0
                    || a.column_limit > 50
                    || a.text_attribute
                        .as_deref()
                        .is_some_and(|v| !["names", "levels"].contains(&v))
                    || a.text_start == 0
                    || a.text_start > 9007199254740991
                    || a.text_limit_bytes == 0
                    || a.text_limit_bytes > 65536
                {
                    return Err(RQueryValidationError("Object reads require one-based indices, limit 1..=200, column_limit 1..=50, and text_limit_bytes 1..=65536".into()));
                }
                Ok(WorkspaceQuery::ReadObject(
                    ScopedWorkspaceArguments::unbound(a),
                ))
            }
            WorkspaceQueryKind::PackageIndex => {
                let a: PackageIndexArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                validate_reference(a.index_ref.as_deref())?;
                validate_reference(Some(&a.observation_id))?;
                if a.limit == 0
                    || a.limit > 200
                    || a.filter.len() > 512
                    || a.package.is_empty()
                    || a.package.len() > 128
                    || !a
                        .package
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'.')
                    || a.library_path.len() > 16384
                    || a.library_path.contains('\0')
                    || a.kind.as_deref().is_some_and(|v| {
                        !["export", "alias", "topic", "declaration", "unresolved"].contains(&v)
                    })
                    || (a.index_ref.is_none() && a.offset != 0)
                {
                    return Err(RQueryValidationError("Package index requires an exact observed package copy, limit 1..=200, bounded filter, and index reference for continuation".into()));
                }
                Ok(WorkspaceQuery::PackageIndex(
                    ScopedWorkspaceArguments::unbound(a),
                ))
            }
            WorkspaceQueryKind::Packages => {
                let args: PackageQueryArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                if args.limit == 0
                    || args.limit > 200
                    || args.offset > 10000
                    || args.filter.chars().count() > 128
                    || args.filter.contains('\0')
                    || args.observation_id.as_ref().is_some_and(|id| {
                        id.len() > 64
                            || id.is_empty()
                            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    })
                    || args.package_name.as_ref().is_some_and(|name| {
                        name.is_empty()
                            || name.len() > 128
                            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
                    })
                {
                    return Err(RQueryValidationError("Packages requires limit 1..=200, offset <= 10000 and a filter of at most 128 characters".into()));
                }
                if args.observation_id.is_some() && args.expected_session.is_none() {
                    return Err(RQueryValidationError(
                        "Cached package reads require expected_session".into(),
                    ));
                }
                Ok(WorkspaceQuery::Packages(args))
            }

            WorkspaceQueryKind::Snapshot => {
                let args: SnapshotArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                if args.limit == 0 || args.limit > MAX_SNAPSHOT_ITEMS {
                    return Err(RQueryValidationError(
                        "snapshot limit must be 1..=200".into(),
                    ));
                }
                Ok(WorkspaceQuery::Snapshot(args))
            }
            WorkspaceQueryKind::InspectObject => {
                let args: InspectArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                if args.name.is_empty()
                    || args.name.len() > 4096
                    || args.name.chars().count() > 1024
                    || args.name.contains('\0')
                    || args.max_items == 0
                    || args.max_items > MAX_PREVIEW_ITEMS
                {
                    return Err(RQueryValidationError(
                        "inspect requires a bounded name and max_items in 1..=100".into(),
                    ));
                }
                Ok(WorkspaceQuery::InspectObject(args))
            }
        }
    }
}

fn validate_reference(reference: Option<&str>) -> Result<(), RQueryValidationError> {
    if reference.is_some_and(|v| {
        v.is_empty() || v.len() > 128 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    }) {
        return Err(RQueryValidationError(
            "Invalid Workspace observation reference".into(),
        ));
    }
    Ok(())
}
fn validate_path(path: &[crate::ObjectPathElement]) -> Result<(), RQueryValidationError> {
    if path.len() > 32
        || path.iter().any(|step| match step {
            crate::ObjectPathElement::Index { index } => *index == 0 || *index > 9007199254740991,
            crate::ObjectPathElement::Name { name } => name.len() > 4096 || name.contains('\0'),
        })
    {
        return Err(RQueryValidationError(
            "Object paths allow at most 32 exact names or positive R indices".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn callers_cannot_supply_native_observation_scope() {
        let kind = WorkspaceQueryKind::ListObjects;
        let arguments = json!({"expected_session":"session", "name_contains":"中文"});
        let mut forged = arguments.clone();
        forged["scope"] = json!({"project":"other", "principal":"other", "session":"other"});
        assert!(kind.parse(&forged).is_err());
        let mut query = kind.parse(&arguments).unwrap();
        query.bind_scope(WorkspaceQueryScope {
            project: "/trusted/project".into(),
            principal: "trusted-principal".into(),
            session: "session".into(),
        });
        let WorkspaceQuery::ListObjects(bound) = query else {
            panic!("wrong query kind");
        };
        assert_eq!(bound.arguments.name_contains, "中文");
        assert_eq!(bound.scope.project, "/trusted/project");
        assert_eq!(bound.scope.principal, "trusted-principal");
        assert_eq!(bound.scope.session, "session");
    }

    #[test]
    fn progressive_reads_require_original_references_and_bounded_coordinates() {
        assert!(
            WorkspaceQueryKind::ListObjects
                .parse(&json!({"expected_session":"session", "offset":1}))
                .is_err()
        );
        assert!(
            WorkspaceQueryKind::Packages
                .parse(&json!({"observation_id":"observed"}))
                .is_err()
        );
        let read = json!({"expected_session":"session", "object_ref":"observed", "kind":"values"});
        assert!(WorkspaceQueryKind::ReadObject.parse(&read).is_ok());
        for path in [
            json!([{"kind":"index", "index":0}]),
            json!([{"kind":"name", "name":"bad\0name"}]),
            json!(
                (0..33)
                    .map(|_| json!({"kind":"index", "index":1}))
                    .collect::<Vec<_>>()
            ),
        ] {
            let mut request = read.clone();
            request["path"] = path;
            assert!(WorkspaceQueryKind::ReadObject.parse(&request).is_err());
        }
        let mut invalid = read;
        invalid["text_limit_bytes"] = json!(65537);
        assert!(WorkspaceQueryKind::ReadObject.parse(&invalid).is_err());
    }
}
