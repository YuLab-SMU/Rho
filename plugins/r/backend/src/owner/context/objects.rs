//! Object summaries revalidate the native handle; they never evaluate bindings
//! or silently observe a replacement object. Search stores identities only.
use super::*;
use rho_r_api::{ObjectDirectoryPage, ObjectObservation, ObjectPathElement, ObjectReadPage};
const SEARCH: &str = "r.context.objects.search";
const PREVIEW: &str = "r.context.objects.preview";
pub(super) fn is_query(id: &str) -> bool {
    matches!(id, SEARCH | PREVIEW)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    session: String,
    name: String,
    object_ref: String,
    observed_path: Vec<ObjectPathElement>,
    path: Vec<ObjectPathElement>,
}
impl Source {
    fn item(&self, owner: &InstanceRef, window: &WindowId) -> Result<ContextItem, String> {
        check(
            !self.session.is_empty()
                && !self.name.is_empty()
                && !self.object_ref.is_empty()
                && self.path.len() + self.observed_path.len() <= 32,
            "Invalid original object source",
        )?;
        let item = ContextItem {
            reference: ContextReference { provider: owner.clone(), window: window.clone(),
                contribution: ContributionId::new("objects").unwrap(), selector: json!(self) },
            title: format!("Object {}", self.name).chars().take(160).collect(),
            description: "Bounded native metadata and recognition sample; not the whole object. Preview rechecks the original handle and path.".into(),
            kind: "text".into(),
        };
        item.validate().map_err(|e| e.to_string())?;
        Ok(item)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LiveCursor {
    owner: InstanceRef,
    principal: PrincipalId,
    window: WindowId,
    text: String,
    session: String,
    directory_ref: String,
    offset: u32,
}
fn context_page(
    items: Vec<ContextItem>,
    next: Option<Value>,
    notices: Vec<String>,
) -> Result<Value, String> {
    let page = ContextPage {
        items,
        next,
        notices,
    };
    page.validate().map_err(|e| e.to_string())?;
    Ok(json!(page))
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Inclusion {
    Summary {},
}
impl Owner {
    async fn search_live_objects(&self, call: &PluginCall) -> Result<Value, String> {
        let request: ContextSearch = decode(call.arguments.clone())?;
        request.validate().map_err(|e| e.to_string())?;
        let after: Option<LiveCursor> = request.after.clone().map(decode).transpose()?;
        let session = self
            .runtime
            .lock()
            .unwrap()
            .as_ref()
            .map(|runtime| runtime.session_id().to_owned());
        let Some(session) = session else {
            return context_page(
                vec![],
                None,
                vec!["R is not running. Start R in Console to browse workspace objects.".into()],
            );
        };
        if let Some(cursor) = &after {
            check(
                cursor.owner == self.instance
                    && cursor.principal == call.principal
                    && cursor.window == request.window
                    && cursor.text == request.text
                    && cursor.session == session,
                "Object continuation belongs to another provider, caller, window, search or native session",
            )?;
        }
        let mut read = call.clone();
        read.binding.target = Some(session.clone());
        read.binding.capability = environment_binding::key("r.list_objects", 1);
        read.arguments = json!({"expected_session":session,"name_contains":request.text,
            "directory_ref":after.as_ref().map(|c| &c.directory_ref),"offset":after.as_ref().map_or(0,|c|c.offset),"limit":request.limit});
        let observed: RInspection<ObjectDirectoryPage> =
            decode(self.inspect(&read, WorkspaceQueryKind::ListObjects).await?)?;
        if observed.status != RInspectionStatus::Ready {
            let message = observed.diagnostic.map(|d| d.message).unwrap_or_else(|| {
                "R is busy. Browse objects again after the current work settles.".into()
            });
            return context_page(vec![], None, vec![message]);
        }
        check(
            observed.session_id == session,
            "Object directory changed its native session",
        )?;
        let directory = observed.data.ok_or("Object directory is unavailable")?;
        let mut items = vec![];
        let mut next_offset = directory.next_offset;
        let mut unavailable = 0;
        for (index, entry) in directory.entries.into_iter().enumerate() {
            read.binding.capability = environment_binding::key("r.observe_object", 1);
            read.arguments = json!({"expected_session":session,"name":entry.name});
            let observed: RInspection<ObjectObservation> = decode(
                self.inspect(&read, WorkspaceQueryKind::ObserveObject)
                    .await?,
            )?;
            if observed.status == RInspectionStatus::Busy {
                if index == 0 {
                    return Err("R became busy while browsing objects. Continue after the current work settles.".into());
                }
                next_offset = Some(directory.offset + index as u32);
                break;
            }
            if observed.status != RInspectionStatus::Ready {
                unavailable += 1;
                continue;
            }
            check(
                observed.session_id == session,
                "Object observation changed its native session",
            )?;
            let object = observed.data.ok_or("Object observation is unavailable")?;
            check(
                object.name == entry.name && object.path.is_empty(),
                "Object observation changed its name or path",
            )?;
            items.push(
                Source {
                    session: session.clone(),
                    name: object.name,
                    object_ref: object.object_ref,
                    observed_path: object.path,
                    path: vec![],
                }
                .item(&self.instance, &request.window)?,
            );
        }
        let next = next_offset.map(|offset| {
            json!(LiveCursor {
                owner: self.instance.clone(),
                principal: call.principal.clone(),
                window: request.window,
                text: request.text,
                session,
                directory_ref: directory.directory_ref,
                offset
            })
        });
        let mut notices = vec!["Current workspace objects. References capture this native session; preview rechecks the original object without evaluating bindings.".into()];
        if unavailable > 0 {
            notices.push(format!("{unavailable} object(s) became unavailable while browsing. Search again to obtain fresh references."));
        }
        if next_offset.is_some() {
            notices.push(
                "More objects or interrupted observations remain; continue when R is idle.".into(),
            );
        }
        if !directory.notices.is_empty() || !observed.notices.is_empty() {
            let mut native = observed.notices;
            native.extend(directory.notices);
            for notice in native.into_iter().take(5) {
                notices.push(notice.chars().take(900).collect());
            }
        }
        context_page(items, next, notices)
    }
    pub(super) async fn query_objects_context(&self, call: &PluginCall) -> Result<Value, String> {
        if call.binding.capability.id.as_str() == SEARCH {
            return self.search_live_objects(call).await;
        }
        let request: PreviewContext = decode(call.arguments.clone())?;
        request.validate().map_err(|e| e.to_string())?;
        check(
            request.reference.provider == self.instance
                && request.reference.contribution.as_str() == "objects",
            "Object source belongs to another provider or contribution",
        )?;
        let source: Source = decode(request.reference.selector.clone())?;
        let _: Inclusion = decode(request.inclusion.clone())?;
        source.item(&self.instance, &request.reference.window)?;
        let mut read = call.clone();
        read.binding.capability = environment_binding::key("r.read_object", 1);
        read.arguments = json!({"expected_session":source.session,"object_ref":source.object_ref,"path":source.path,"kind":"structure","limit":1,"column_limit":1});
        let observed: RInspection<ObjectReadPage> =
            decode(self.inspect(&read, WorkspaceQueryKind::ReadObject).await?)?;
        check(
            observed.status == RInspectionStatus::Ready && observed.session_id == source.session,
            "The original object is busy, changed, expired or unavailable; open it again",
        )?;
        let page = observed
            .data
            .ok_or("Original object metadata is unavailable")?;
        check(
            observed.completeness
                == if page.complete {
                    NativeCompleteness::Complete
                } else {
                    NativeCompleteness::Partial
                },
            "Object completeness is inconsistent",
        )?;
        Ok(json!(preview(&self.instance, request, &source, page)?))
    }
}
fn preview(
    owner: &InstanceRef,
    request: PreviewContext,
    source: &Source,
    page: ObjectReadPage,
) -> Result<ContextPreview, String> {
    check(
        page.object_ref == source.object_ref
            && page.root_name == source.name
            && json!(page.path) == json!(source.path)
            && json!(page.observed_path) == json!(source.observed_path)
            && matches!(page.kind, rho_r_api::ObjectReadKind::Structure),
        "Object read changed its original identity or path",
    )?;
    // This inclusion is the bounded metadata, not the full native structure page.
    // Native notices (including shortened attributes/previews) stay visible.
    let mut text = format!(
        "Object: {}\nObserved path: {}\nRelative path: {}\nBounded metadata and recognition sample (not the whole object):\n{}",
        source.name,
        json!(source.observed_path),
        json!(source.path),
        serde_json::to_string_pretty(&page.metadata).map_err(|e| e.to_string())?
    );
    let limit = request.max_bytes.min(16384) as usize;
    let truncated = text.len() > limit;
    if truncated {
        let mut end = limit;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    let result = ContextPreview {
        item: source.item(owner, &request.reference.window)?,
        text,
        truncated,
        data: json!({"inclusion":"summary","native_session":source.session,"observed_at_ms":page.observed_at_ms,"structure_page_complete":page.complete,"notices":page.notices,
            "annotation_version_scope":"bounded_object_summary",
            "annotation_anchors":[{"kind":"structured","path":std::iter::once(source.name.clone()).chain(source.observed_path.iter().chain(source.path.iter()).map(|part| match part { ObjectPathElement::Name { name } => name.clone(), ObjectPathElement::Index { index } => format!("[{index}]") })).collect::<Vec<_>>(),"row":null,"column":null,"topic":null}],
            "annotation_source":summary_identity("object-summary",json!([source.session,source.name,source.observed_path,source.path]),json!([page.metadata,page.notices,page.complete]))?}),
        resources: vec![],
    };
    check(
        result.item.reference == request.reference,
        "Object preview changed the original reference",
    )?;
    result.validate().map_err(|e| e.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Source {
        decode(json!({"session":"native","name":"研究🙂","object_ref":"observed","observed_path":[],"path":[]})).unwrap()
    }
    fn page(source: &Source) -> ObjectReadPage {
        decode(json!({"object_ref":source.object_ref,"root_name":source.name,"observed_path":source.observed_path,"path":source.path,"kind":"structure",
            "metadata":{"kind":"value","object_type":"list","classes":[],"length":100,"dimensions":[],"supported_reads":["structure"],"attributes":[],"notice":"Bounded metadata", "preview":[]},
            "values":[],"children":[],"columns":[],"start":1,"next_start":2,"column_start":1,"next_column_start":null,"text_start":1,"next_text_start":null,"observed_at_ms":1,"complete":false,"notices":["Continue the native page"]})).unwrap()
    }
    #[tokio::test]
    async fn objects_search_and_original_preview_never_start_r() {
        let (_directory, owner, mut call, mut host) = super::super::tests::fixture();
        call.binding.capability = environment_binding::key(SEARCH, 1);
        let empty: ContextPage = decode(owner.query(&call).await.unwrap()).unwrap();
        assert!(empty.items.is_empty());
        call.binding.capability = environment_binding::key(PREVIEW, 1);
        call.arguments = json!({"reference":source().item(&owner.instance,&WindowId::new("window").unwrap()).unwrap().reference,"inclusion":{"kind":"summary"},"max_bytes":16384});
        assert!(owner.query(&call).await.is_err());
        assert!(owner.runtime.lock().unwrap().is_none());
        assert!(host.try_recv().is_err());
    }
    #[test]
    fn summary_keeps_bounds_unicode_and_rejects_substituted_identity() {
        let (_directory, owner, _, _host) = super::super::tests::fixture();
        let source = source();
        let request:PreviewContext=decode(json!({"reference":source.item(&owner.instance,&WindowId::new("window").unwrap()).unwrap().reference,"inclusion":{"kind":"summary"},"max_bytes":16384})).unwrap();
        let result = preview(&owner.instance, request.clone(), &source, page(&source)).unwrap();
        assert!(!result.truncated);
        assert!(result.text.contains("not the whole object"));
        assert_eq!(result.data["structure_page_complete"], false);
        assert!(result.text.contains("研究🙂"));
        let original_identity = result.data["annotation_source"].clone();
        let mut fresh_source = source.clone();
        fresh_source.object_ref = "fresh-observation".into();
        let mut fresh_request = request.clone();
        fresh_request.reference = fresh_source
            .item(&owner.instance, &request.reference.window)
            .unwrap()
            .reference;
        let mut fresh_page = page(&fresh_source);
        fresh_page.observed_at_ms = 999;
        let fresh = preview(
            &owner.instance,
            fresh_request.clone(),
            &fresh_source,
            fresh_page.clone(),
        )
        .unwrap();
        assert_eq!(
            fresh.data["annotation_source"], original_identity,
            "Observation handles/clocks do not version the summary"
        );
        fresh_page.metadata.length = Some(200);
        let changed = preview(&owner.instance, fresh_request, &fresh_source, fresh_page).unwrap();
        assert_eq!(
            changed.data["annotation_source"]["source_id"],
            original_identity["source_id"]
        );
        assert_ne!(
            changed.data["annotation_source"]["source_version"],
            original_identity["source_version"]
        );
        let mut bounded = request.clone();
        bounded.max_bytes = 11;
        let result = preview(&owner.instance, bounded, &source, page(&source)).unwrap();
        assert!(result.truncated);
        assert!(result.text.len() <= 11);
        for changed in ["object_ref", "root_name", "path", "observed_path", "kind"] {
            let mut raw = json!(page(&source));
            raw[changed] = match changed {
                "path" | "observed_path" => json!([{"kind":"index","index":1}]),
                "kind" => json!("values"),
                _ => json!("different"),
            };
            assert!(
                preview(
                    &owner.instance,
                    request.clone(),
                    &source,
                    decode(raw).unwrap()
                )
                .is_err(),
                "{changed}"
            );
        }
    }
}
