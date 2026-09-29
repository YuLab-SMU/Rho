//! Object summaries revalidate the native handle; they never evaluate bindings
//! or silently observe a replacement object. Search stores identities only.
use super::*;
use rho_r_api::{ObjectPathElement, ObjectObservation, ObjectReadPage, ObserveObjectArguments};
const SEARCH: &str = "r.context.objects.search";
const PREVIEW: &str = "r.context.objects.preview";
pub(super) fn is_query(id: &str) -> bool { matches!(id, SEARCH | PREVIEW) }
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
        check(!self.session.is_empty() && !self.name.is_empty() && !self.object_ref.is_empty()
            && self.path.len() + self.observed_path.len() <= 32, "Invalid original object source")?;
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
#[derive(Default)]
pub(crate) struct Catalog { items: BTreeMap<String, Source>, order: std::collections::VecDeque<String> }
impl Catalog {
    pub(crate) fn observe(&mut self, arguments: &Value, observation: &RInspection<Value>) {
        if observation.status != RInspectionStatus::Ready { return; }
        let (Ok(args), Some(data)) = (decode::<ObserveObjectArguments>(arguments.clone()), &observation.data) else {return;};
        let Ok(page) = decode::<ObjectObservation>(data.clone()) else {return;};
        if observation.session_id != args.expected_session || page.name != args.name || json!(page.path) != json!(args.path) {return;}
        let source = Source {session: args.expected_session, name: page.name, object_ref: page.object_ref, observed_path: page.path, path: vec![]};
        let encoded = serde_json::to_vec(&source).unwrap();
        if encoded.len() > MAX_CONTEXT_SELECTOR_BYTES {return;}
        let key = format!("sha256:{:x}", Sha256::digest(encoded));
        self.order.retain(|old| old != &key); self.order.push_back(key.clone()); self.items.insert(key, source);
        while self.items.len() > 100 { self.items.remove(&self.order.pop_front().unwrap()); }
    }
    fn search(&self, owner: &InstanceRef, request: ContextSearch) -> Result<ContextPage, String> {
        request.validate().map_err(|e| e.to_string())?;
        let after = request.after.as_ref().map(|value| decode::<Cursor>(value.clone())).transpose()?;
        if let Some(cursor) = &after {
            check(cursor.owner == *owner && cursor.window == request.window && cursor.text == request.text && cursor.contribution == "objects", "Object continuation belongs to another provider, window or search")?;
        }
        let matching = self.items.iter().filter(|(key, source)| !after.as_ref().is_some_and(|cursor| *key <= &cursor.after)
            && source.name.to_lowercase().contains(&request.text.to_lowercase())).take(usize::from(request.limit) + 1).collect::<Vec<_>>();
        let items = matching.iter().take(usize::from(request.limit)).map(|(_,source)| source.item(owner,&request.window)).collect::<Result<Vec<_>,_>>()?;
        let next = (matching.len() > usize::from(request.limit)).then(|| json!(Cursor {
            owner:owner.clone(),window:request.window,text:request.text,contribution:"objects".into(),after:matching[usize::from(request.limit)-1].0.clone()
        }));
        let page = ContextPage {items,next,notices:vec!["Up to 100 previously opened object observations. Handles can expire or change; preview checks them without starting R or observing a replacement.".into()]};
        page.validate().map_err(|e| e.to_string())?; Ok(page)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor { owner: InstanceRef, window: WindowId, text: String, contribution: String, after: String }
#[derive(Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
enum Inclusion { Summary {} }
impl Owner {
    pub(super) async fn query_objects_context(&self, call: &PluginCall) -> Result<Value,String> {
        if call.binding.capability.id.as_str() == SEARCH {
            return Ok(json!(self.object_context.lock().unwrap().search(&self.instance,decode(call.arguments.clone())?)?));
        }
        let request: PreviewContext = decode(call.arguments.clone())?;
        request.validate().map_err(|e|e.to_string())?;
        check(request.reference.provider == self.instance && request.reference.contribution.as_str() == "objects", "Object source belongs to another provider or contribution")?;
        let source: Source = decode(request.reference.selector.clone())?;
        let _: Inclusion = decode(request.inclusion.clone())?;
        source.item(&self.instance,&request.reference.window)?;
        let mut read = call.clone();
        read.binding.capability = environment_binding::key("r.read_object",1);
        read.arguments = json!({"expected_session":source.session,"object_ref":source.object_ref,"path":source.path,"kind":"structure","limit":1,"column_limit":1});
        let observed: RInspection<ObjectReadPage> = decode(self.inspect(&read,WorkspaceQueryKind::ReadObject).await?)?;
        check(observed.status == RInspectionStatus::Ready && observed.session_id == source.session,
            "The original object is busy, changed, expired or unavailable; open it again")?;
        let page = observed.data.ok_or("Original object metadata is unavailable")?;
        check(observed.completeness == if page.complete {NativeCompleteness::Complete} else {NativeCompleteness::Partial}, "Object completeness is inconsistent")?;
        Ok(json!(preview(&self.instance,request,&source,page)?))
    }
}
fn preview(owner: &InstanceRef, request: PreviewContext, source: &Source, page: ObjectReadPage) -> Result<ContextPreview,String> {
    check(page.object_ref == source.object_ref && page.root_name == source.name && json!(page.path) == json!(source.path)
        && json!(page.observed_path) == json!(source.observed_path) && matches!(page.kind,rho_r_api::ObjectReadKind::Structure), "Object read changed its original identity or path")?;
    // This inclusion is the bounded metadata, not the full native structure page.
    // Native notices (including shortened attributes/previews) stay visible.
    let mut text = format!("Object: {}\nObserved path: {}\nRelative path: {}\nBounded metadata and recognition sample (not the whole object):\n{}",
        source.name,json!(source.observed_path),json!(source.path),serde_json::to_string_pretty(&page.metadata).map_err(|e|e.to_string())?);
    let limit = request.max_bytes.min(16384) as usize;
    let truncated = text.len() > limit;
    if truncated {let mut end=limit;while !text.is_char_boundary(end){end-=1;}text.truncate(end);}
    let result = ContextPreview { item:source.item(owner,&request.reference.window)?,text,truncated,
        data:json!({"inclusion":"summary","native_session":source.session,"observed_at_ms":page.observed_at_ms,"structure_page_complete":page.complete,"notices":page.notices,
            "annotation_version_scope":"bounded_object_summary",
            "annotation_source":summary_identity("object-summary",json!([source.session,source.name,source.observed_path,source.path]),json!([page.metadata,page.notices,page.complete]))?}),resources:vec![] };
    check(result.item.reference == request.reference,"Object preview changed the original reference")?;
    result.validate().map_err(|e|e.to_string())?; Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Source { decode(json!({"session":"native","name":"研究🙂","object_ref":"observed","observed_path":[],"path":[]})).unwrap() }
    fn page(source:&Source) -> ObjectReadPage {
        decode(json!({"object_ref":source.object_ref,"root_name":source.name,"observed_path":source.observed_path,"path":source.path,"kind":"structure",
            "metadata":{"kind":"value","object_type":"list","classes":[],"length":100,"dimensions":[],"supported_reads":["structure"],"attributes":[],"notice":"Bounded metadata", "preview":[]},
            "values":[],"children":[],"columns":[],"start":1,"next_start":2,"column_start":1,"next_column_start":null,"text_start":1,"next_text_start":null,"observed_at_ms":1,"complete":false,"notices":["Continue the native page"]})).unwrap()
    }
    #[tokio::test]
    async fn objects_search_and_original_preview_never_start_r() {
        let (_directory,owner,mut call,mut host)=super::super::tests::fixture();
        call.binding.capability=environment_binding::key(SEARCH,1);
        let empty:ContextPage=decode(owner.query(&call).await.unwrap()).unwrap();
        assert!(empty.items.is_empty());
        call.binding.capability=environment_binding::key(PREVIEW,1);
        call.arguments=json!({"reference":source().item(&owner.instance,&WindowId::new("window").unwrap()).unwrap().reference,"inclusion":{"kind":"summary"},"max_bytes":16384});
        assert!(owner.query(&call).await.is_err());
        assert!(owner.runtime.lock().unwrap().is_none());
        assert!(host.try_recv().is_err());
    }
    #[test]
    fn summary_keeps_bounds_unicode_and_rejects_substituted_identity() {
        let (_directory,owner,_,_host)=super::super::tests::fixture();
        let source=source();
        let request:PreviewContext=decode(json!({"reference":source.item(&owner.instance,&WindowId::new("window").unwrap()).unwrap().reference,"inclusion":{"kind":"summary"},"max_bytes":16384})).unwrap();
        let result=preview(&owner.instance,request.clone(),&source,page(&source)).unwrap();
        assert!(!result.truncated); assert!(result.text.contains("not the whole object"));
        assert_eq!(result.data["structure_page_complete"],false);
        assert!(result.text.contains("研究🙂"));
        let original_identity=result.data["annotation_source"].clone();
        let mut fresh_source=source.clone();fresh_source.object_ref="fresh-observation".into();
        let mut fresh_request=request.clone();fresh_request.reference=fresh_source.item(&owner.instance,&request.reference.window).unwrap().reference;
        let mut fresh_page=page(&fresh_source);fresh_page.observed_at_ms=999;
        let fresh=preview(&owner.instance,fresh_request.clone(),&fresh_source,fresh_page.clone()).unwrap();
        assert_eq!(fresh.data["annotation_source"],original_identity,"Observation handles/clocks do not version the summary");
        fresh_page.metadata.length=Some(200);
        let changed=preview(&owner.instance,fresh_request,&fresh_source,fresh_page).unwrap();
        assert_eq!(changed.data["annotation_source"]["source_id"],original_identity["source_id"]);
        assert_ne!(changed.data["annotation_source"]["source_version"],original_identity["source_version"]);
        let mut bounded=request.clone();bounded.max_bytes=11;
        let result=preview(&owner.instance,bounded,&source,page(&source)).unwrap();assert!(result.truncated);assert!(result.text.len()<=11);
        for changed in ["object_ref","root_name","path","observed_path","kind"] {
            let mut raw=json!(page(&source));
            raw[changed]=match changed {"path"|"observed_path"=>json!([{"kind":"index","index":1}]),"kind"=>json!("values"),_=>json!("different")};
            assert!(preview(&owner.instance,request.clone(),&source,decode(raw).unwrap()).is_err(),"{changed}");
        }
    }
    #[test]
    fn catalog_is_bounded_and_continuation_is_owner_window_and_search_bound() {
        let (_directory,owner,call,_host)=super::super::tests::fixture();
        let mut catalog=Catalog::default();
        for n in 0..102 {
            let args=json!({"expected_session":"native","name":format!("object-{n}"),"path":[]});
            let data=json!({"name":format!("object-{n}"),"object_ref":format!("ref-{n}"),"path":[],"metadata":page(&source()).metadata,"observed_at_ms":1,"expires_at_ms":60001});
            let observation:RInspection<Value>=decode(json!({"session_id":"native","status":"ready","source":"R","observed_at_ms":1,"completeness":"complete","data":data,"notices":[],"diagnostic":null})).unwrap();
            catalog.observe(&args,&observation);
        }
        assert_eq!(catalog.items.len(),100);
        let mut request:ContextSearch=decode(call.arguments).unwrap();request.limit=1;
        let first=catalog.search(&owner.instance,request.clone()).unwrap();assert_eq!(first.items.len(),1);
        request.after=first.next;let next=catalog.search(&owner.instance,request.clone()).unwrap();assert_ne!(first.items[0].reference,next.items[0].reference);
        request.window=WindowId::new("other").unwrap();assert!(catalog.search(&owner.instance,request).is_err());
    }
}
