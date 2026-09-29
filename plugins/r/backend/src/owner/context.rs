//! Owner-defined contexts use the same exact native observations as Help and
//! Viewer. References carry identity only; they confer no authority or recovery.
use super::*;
use serde::Serialize;
use std::collections::BTreeMap;
mod viewer;
mod objects;
mod packages;
pub(super) use packages::Catalog as PackageCatalog;
pub(super) use objects::Catalog as ObjectCatalog;

const HELP: &str = "help";
const HELP_SEARCH: &str = "r.context.help.search";
const HELP_PREVIEW: &str = "r.context.help.preview";
const MAX_OBSERVED_TOPICS: usize = 100;

pub fn is_query(id: &str) -> bool {
    matches!(id, HELP_SEARCH | HELP_PREVIEW) || viewer::is_query(id) || objects::is_query(id) || packages::is_query(id)
}
pub(super) struct Grants {
    get: bool,
    list: bool,
    resources: bool,
}
impl Grants {
    pub(super) fn new(grants: &[CapabilityRequirement]) -> Self {
        let has = |id: &str, scope: &str| {
            grants.iter().any(|g| {
                g.capability == environment_binding::key(id, 1) && g.scopes.contains(scope)
            })
        };
        Self {
            get: has("operation.get", "operation.read"),
            list: has("operation.list_recent", "operation.read"),
            resources: has("resources.read", "resources.read"),
        }
    }
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}
fn check(ok: bool, message: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(message.into()) }
}
// Version only the owner-authored bounded summary, excluding observation clocks
// and temporary handles. This is not a digest of an entire native object/package.
fn summary_identity(kind: &str, lineage: Value, content: Value) -> Result<Value, String> {
    let digest = |value: &Value| -> Result<String, String> {
        Ok(format!("sha256:{:x}", Sha256::digest(serde_json::to_vec(value).map_err(|e|e.to_string())?)))
    };
    Ok(json!({"source_id":format!("{kind}:{}",digest(&lineage)?),"source_version":digest(&content)?}))
}
fn same_files(a: &[PackageFileIdentity], b: &[PackageFileIdentity]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(a, b)| a.path == b.path && a.digest == b.digest)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HelpSource {
    session: String,
    observation: String,
    package: String,
    library: String,
    topic: String,
    index_files: Vec<PackageFileIdentity>,
    help_files: Vec<PackageFileIdentity>,
}
impl HelpSource {
    fn title(&self) -> String {
        format!("{}::{}", self.package, self.topic)
    }
    fn description(&self) -> String {
        format!("Observed Help topic · {}", self.library)
    }
    fn key(&self) -> String {
        format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(self).unwrap())
        )
    }
    fn item(&self, owner: &InstanceRef, window: &WindowId) -> Result<ContextItem, String> {
        let item = ContextItem {
            reference: ContextReference {
                provider: owner.clone(),
                contribution: ContributionId::new(HELP).unwrap(),
                window: window.clone(),
                selector: json!(self),
            },
            title: self.title(),
            description: self.description(),
            kind: "text".into(),
        };
        item.validate().map_err(|e| e.to_string())?;
        Ok(item)
    }
    fn arguments(&self, max_bytes: u32) -> ReadPackageHelpArguments {
        ReadPackageHelpArguments {
            expected_session: self.session.clone(),
            observation_id: self.observation.clone(),
            package: self.package.clone(),
            library_path: self.library.clone(),
            topic: self.topic.clone(),
            expected_index_files: self.index_files.clone(),
            expected_help_files: Some(self.help_files.clone()),
            offset_utf8: 0,
            limit_bytes: max_bytes.min(32768),
            format: HelpFormat::Text,
        }
    }
    fn matches(&self, page: &PackageHelpPage) -> bool {
        page.observation_id == self.observation
            && page.package == self.package
            && page.library_path == self.library
            && page.topic == self.topic
            && same_files(&page.help_files, &self.help_files)
    }
}

/// A bounded index of observed topic identities, never a second content store.
/// Reopening an R instance clears it; old references still require their original
/// native session. Search never starts R or creates a new package observation.
#[derive(Default)]
pub(super) struct HelpCatalog {
    topics: BTreeMap<String, HelpSource>,
    order: std::collections::VecDeque<String>,
}
impl HelpCatalog {
    pub(super) fn observe(&mut self, arguments: &Value, observation: &RInspection<Value>) {
        if observation.status != RInspectionStatus::Ready {
            return;
        }
        let Some(data) = &observation.data else {
            return;
        };
        let (Ok(args), Ok(page)) = (
            decode::<ReadPackageHelpArguments>(arguments.clone()),
            decode::<PackageHelpPage>(data.clone()),
        ) else {
            return;
        };
        if !page.found
            || observation.completeness != page_completeness(&page)
            || observation.session_id != args.expected_session
            || page.observation_id != args.observation_id
            || page.package != args.package
            || page.library_path != args.library_path
            || page.topic != args.topic
            || args
                .expected_help_files
                .as_ref()
                .is_some_and(|files| !same_files(files, &page.help_files))
        {
            return;
        }
        let source = HelpSource {
            session: args.expected_session,
            observation: page.observation_id,
            package: page.package,
            library: page.library_path,
            topic: page.topic,
            index_files: args.expected_index_files,
            help_files: page.help_files,
        };
        if serde_json::to_vec(&source).is_ok_and(|bytes| bytes.len() <= MAX_CONTEXT_SELECTOR_BYTES)
        {
            let key = source.key();
            self.order.retain(|old| old != &key);
            self.order.push_back(key.clone());
            self.topics.insert(key, source);
            while self.topics.len() > MAX_OBSERVED_TOPICS {
                self.topics.remove(&self.order.pop_front().unwrap());
            }
        }
    }
    fn search(&self, owner: &InstanceRef, request: ContextSearch) -> Result<ContextPage, String> {
        request.validate().map_err(|e| e.to_string())?;
        let after = request
            .after
            .as_ref()
            .map(|cursor| decode::<HelpCursor>(cursor.clone()))
            .transpose()?;
        if let Some(cursor) = &after {
            cursor.check(owner, &request)?;
        }
        let text = request.text.to_lowercase();
        let mut items = vec![];
        let mut last = None;
        let mut more = false;
        for (key, source) in &self.topics {
            if after.as_ref().is_some_and(|cursor| key <= &cursor.after)
                || !format!("{} {}", source.title(), source.library)
                    .to_lowercase()
                    .contains(&text)
            {
                continue;
            }
            // Do not conceal an unrepresentable source as an empty complete page.
            let item = source.item(owner, &request.window)?;
            if items.len() == usize::from(request.limit) {
                more = true;
                break;
            }
            items.push(item);
            last = Some(key.clone());
        }
        let next = if more {
            Some(json!(HelpCursor {
                owner: owner.clone(),
                window: request.window,
                text: request.text,
                after: last.unwrap()
            }))
        } else {
            None
        };
        let page = ContextPage { items, next, notices: vec!["Only previously observed Help topics are listed (up to 100). Open a topic in Help to include it. Preview rechecks its original installed copy.".into()] };
        page.validate().map_err(|e| e.to_string())?;
        Ok(page)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HelpCursor {
    owner: InstanceRef,
    window: WindowId,
    text: String,
    after: String,
}
impl HelpCursor {
    fn check(&self, owner: &InstanceRef, request: &ContextSearch) -> Result<(), String> {
        check(
            self.owner == *owner && self.window == request.window && self.text == request.text,
            "Help context continuation belongs to another provider, window or search",
        )
    }
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum HelpInclusion {
    Text {},
    Excerpt {},
}

impl Owner {
    pub(super) async fn query_context(&self, call: &PluginCall) -> Result<Value, String> {
        check(
            call.binding.provider == self.instance
                && call.binding.target.is_none()
                && call.operation_id.is_none()
                && call.binding.capability.version == 1
                && call.preconditions.is_null()
                && call.owner_context.is_null()
                && call.scopes.contains("workspace.read"),
            "Context requires an exact owner, workspace.read and no runtime target or mutation preconditions",
        )?;
        match call.binding.capability.id.as_str() {
            id if packages::is_query(id) => self.query_packages_context(call).await,
            id if objects::is_query(id) => self.query_objects_context(call).await,
            id if viewer::is_query(id) => self.query_viewer_context(call).await,
            HELP_SEARCH => Ok(json!(
                self.help_context
                    .lock()
                    .unwrap()
                    .search(&self.instance, decode(call.arguments.clone())?)?
            )),
            HELP_PREVIEW => {
                let request: PreviewContext = decode(call.arguments.clone())?;
                request.validate().map_err(|e| e.to_string())?;
                check(
                    request.reference.provider == self.instance
                        && request.reference.contribution.as_str() == HELP,
                    "Help reference belongs to another provider or contribution",
                )?;
                let source: HelpSource = decode(request.reference.selector.clone())?;
                let inclusion: HelpInclusion = decode(request.inclusion.clone())?;
                let mut read = call.clone();
                read.binding.capability = environment_binding::key("r.read_help", 1);
                read.arguments = json!(source.arguments(request.max_bytes));
                // The existing owner binds project/principal and checks native session,
                // queued work, copy observation and both sets of static file identities.
                let observation: RInspection<PackageHelpPage> =
                    decode(self.inspect(&read, WorkspaceQueryKind::ReadHelp).await?)?;
                check(
                    observation.status == RInspectionStatus::Ready,
                    "The original Help source is busy, changed, partial or unavailable; select it again",
                )?;
                check(
                    observation.session_id == source.session,
                    "Help returned another native session",
                )?;
                let page = observation.data.ok_or("Help content is unavailable")?;
                // Native completeness describes this bounded content page.
                // A partial page can still contain the complete declared excerpt;
                // the preview below validates its exact byte continuation.
                check(
                    observation.completeness == page_completeness(&page),
                    "Help page completeness is inconsistent",
                )?;
                Ok(json!(help_preview(
                    &self.instance,
                    request,
                    &source,
                    inclusion,
                    page
                )?))
            }
            _ => Err("Unknown context capability".into()),
        }
    }
}
fn page_completeness(page: &PackageHelpPage) -> NativeCompleteness {
    if page.complete {
        NativeCompleteness::Complete
    } else {
        NativeCompleteness::Partial
    }
}
fn help_preview(
    owner: &InstanceRef,
    request: PreviewContext,
    source: &HelpSource,
    inclusion: HelpInclusion,
    page: PackageHelpPage,
) -> Result<ContextPreview, String> {
    check(
        source.matches(&page)
            && page.found
            && page.format == HelpFormat::Text
            && page.offset_utf8 == 0
            && page.text.len() <= request.max_bytes.min(32768) as usize
            && page.total_bytes >= page.text.len() as u64
            && if page.complete {
                page.next_offset_utf8.is_none() && page.total_bytes == page.text.len() as u64
            } else {
                !page.text.is_empty()
                    && page.next_offset_utf8 == Some(page.text.len() as u64)
                    && page.total_bytes > page.text.len() as u64
            },
        "Help content differs from its original identities or bounded continuation",
    )?;
    let (text, truncated, name) = match inclusion {
        HelpInclusion::Text {} => (page.text.clone(), !page.complete, "text"),
        HelpInclusion::Excerpt {} => {
            // A complete first-twelve-lines inclusion can come from a larger
            // topic. A byte-limited partial line is never presented as complete.
            let lines: Vec<_> = page.text.split_inclusive('\n').take(12).collect();
            let complete_excerpt = page.complete
                || lines.len() == 12 && lines.last().is_some_and(|line| line.ends_with('\n'));
            (lines.concat(), !complete_excerpt, "excerpt")
        }
    };
    let preview = ContextPreview {
        item: source.item(owner, &request.reference.window)?,
        text,
        truncated,
        data: json!({"inclusion":name,"format":"text","topic_complete":page.complete,"total_bytes":page.total_bytes,
            "package_version":page.version,"native_session":source.session,
            "annotation_source":{"source_id":format!("help:{:x}",Sha256::digest(serde_json::to_vec(&json!([source.library,source.package,source.topic])).map_err(|e|e.to_string())?)),
            "source_version":format!("sha256:{:x}",Sha256::digest(serde_json::to_vec(&source.help_files).map_err(|e|e.to_string())?))}}),
        resources: vec![],
    };
    check(
        preview.item.reference == request.reference,
        "Help preview changed the captured reference",
    )?;
    preview.validate().map_err(|e| e.to_string())?;
    Ok(preview)
}

#[cfg(test)]
mod tests;
