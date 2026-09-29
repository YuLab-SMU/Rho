//! Installed-copy context is pinned to one native package observation.
use super::viewer::bounded_text;
use super::*;
const SEARCH: &str = "r.context.packages.search";
const PREVIEW: &str = "r.context.packages.preview";
pub(super) fn is_query(id: &str) -> bool {
    matches!(id, SEARCH | PREVIEW)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    session: String,
    observation: String,
    package: String,
    library: String,
    version: String,
}
impl Source {
    fn matches(&self, copy: &PackageEntry) -> bool {
        copy.name == self.package
            && copy.version == self.version
            && copy.library_path.as_deref() == Some(self.library.as_str())
    }
    fn item(&self, owner: &InstanceRef, window: &WindowId) -> Result<ContextItem, String> {
        check(
            !self.session.is_empty()
                && !self.observation.is_empty()
                && !self.package.is_empty()
                && !self.library.is_empty(),
            "Incomplete installed-copy identity",
        )?;
        let item = ContextItem {
            reference: ContextReference {
                provider: owner.clone(),
                window: window.clone(),
                contribution: ContributionId::new("packages").unwrap(),
                selector: json!(self),
            },
            title: format!("{} {}", self.package, self.version),
            description: format!(
                "Installed copy · {} · observation {}",
                self.library, self.observation
            ),
            kind: "text".into(),
        };
        item.validate().map_err(|e| e.to_string())?;
        Ok(item)
    }
}
#[derive(Default)]
pub(crate) struct Catalog {
    items: BTreeMap<String, (String, Source)>,
    order: std::collections::VecDeque<String>,
}
impl Catalog {
    pub(crate) fn observe(&mut self, principal: &str, args: &Value, observed: &RInspection<Value>) {
        if observed.status != RInspectionStatus::Ready {
            return;
        }
        let (Ok(args), Some(data)) = (
            decode::<PackageQueryArguments>(args.clone()),
            &observed.data,
        ) else {
            return;
        };
        let Ok(page) = decode::<PackageSnapshotData>(data.clone()) else {
            return;
        };
        if args.expected_session.as_deref() != Some(observed.session_id.as_str())
            || args.observation_id.as_deref() != Some(page.observation_id.as_str())
            || args.package_name.is_none()
            || args.package_name != page.package_name
            || !args.grouped
            || !args.filter.is_empty()
            || !matches!(args.mode, PackageQueryMode::Installed)
            || page.offset != args.offset
        {
            return;
        }
        for copy in page.packages {
            let Some(library) = copy.library_path else {
                continue;
            };
            if Some(&copy.name) != args.package_name.as_ref() {
                continue;
            }
            let source = Source {
                session: observed.session_id.clone(),
                observation: page.observation_id.clone(),
                package: copy.name,
                library,
                version: copy.version,
            };
            let bytes = serde_json::to_vec(&source).unwrap();
            if bytes.len() > MAX_CONTEXT_SELECTOR_BYTES {
                continue;
            }
            let key = format!(
                "sha256:{:x}",
                Sha256::digest(serde_json::to_vec(&(principal, &source)).unwrap())
            );
            self.order.retain(|old| old != &key);
            self.order.push_back(key.clone());
            self.items.insert(key, (principal.into(), source));
            while self.items.len() > 100 {
                self.items.remove(&self.order.pop_front().unwrap());
            }
        }
    }
    fn search(
        &self,
        owner: &InstanceRef,
        principal: &str,
        request: ContextSearch,
    ) -> Result<ContextPage, String> {
        request.validate().map_err(|e| e.to_string())?;
        let after = request
            .after
            .as_ref()
            .map(|v| decode::<Cursor>(v.clone()))
            .transpose()?;
        if let Some(c) = &after {
            check(
                c.owner == *owner
                    && c.principal == principal
                    && c.window == request.window
                    && c.text == request.text
                    && c.contribution == "packages",
                "Package continuation belongs to another owner, caller or search",
            )?;
        }
        let rows = self
            .items
            .iter()
            .filter(|(key, (caller, source))| {
                caller == principal
                    && after.as_ref().is_none_or(|c| *key > &c.after)
                    && format!("{} {} {}", source.package, source.version, source.library)
                        .to_lowercase()
                        .contains(&request.text.to_lowercase())
            })
            .take(usize::from(request.limit) + 1)
            .collect::<Vec<_>>();
        let items = rows
            .iter()
            .take(usize::from(request.limit))
            .map(|(_, (_, s))| s.item(owner, &request.window))
            .collect::<Result<Vec<_>, _>>()?;
        let next = (rows.len() > usize::from(request.limit)).then(|| {
            json!(Cursor {
                owner: owner.clone(),
                principal: principal.into(),
                window: request.window,
                text: request.text,
                contribution: "packages".into(),
                after: rows[usize::from(request.limit) - 1].0.clone()
            })
        });
        let page=ContextPage{items,next,notices:vec!["Up to 100 previously inspected installed copies. Preview requires the original live observation; it never refreshes inventory or loads a package.".into()]};
        page.validate().map_err(|e| e.to_string())?;
        Ok(page)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    owner: InstanceRef,
    principal: String,
    window: WindowId,
    text: String,
    contribution: String,
    after: String,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Inclusion {
    Metadata {},
}
impl Owner {
    pub(super) async fn query_packages_context(&self, call: &PluginCall) -> Result<Value, String> {
        if call.binding.capability.id.as_str() == SEARCH {
            return Ok(json!(self.package_context.lock().unwrap().search(
                &self.instance,
                call.principal.as_str(),
                decode(call.arguments.clone())?
            )?));
        }
        let request: PreviewContext = decode(call.arguments.clone())?;
        request.validate().map_err(|e| e.to_string())?;
        check(
            request.reference.provider == self.instance
                && request.reference.contribution.as_str() == "packages",
            "Installed-copy context belongs to another provider or contribution",
        )?;
        let source: Source = decode(request.reference.selector.clone())?;
        let _: Inclusion = decode(request.inclusion.clone())?;
        source.item(&self.instance, &request.reference.window)?;
        // Continue only the original immutable native observation. No fresh query
        // is permitted, even if the selected library still contains this version.
        let mut offset = 0;
        loop {
            let mut read = call.clone();
            read.binding.capability = environment_binding::key("r.packages", 1);
            read.arguments = json!({"expected_session":source.session,"observation_id":source.observation,"package_name":source.package,"grouped":true,"mode":"installed","filter":"","offset":offset,"limit":200});
            let observed: RInspection<PackageSnapshotData> =
                decode(self.inspect(&read, WorkspaceQueryKind::Packages).await?)?;
            check(
                observed.status == RInspectionStatus::Ready
                    && observed.session_id == source.session,
                "Original package observation is busy, expired or unavailable; no inventory was refreshed",
            )?;
            let page = observed
                .data
                .ok_or("Missing original package observation")?;
            check(
                page.observation_id == source.observation
                    && page.package_name.as_deref() == Some(source.package.as_str())
                    && page.offset == offset
                    && page.packages.len() <= 200,
                "Installed-copy page differs from the original observation",
            )?;
            if let Some(copy) = page.packages.iter().find(|copy| source.matches(copy)) {
                return Ok(json!(preview(
                    &self.instance,
                    request,
                    &source,
                    &page,
                    copy
                )?));
            }
            let next = page
                .next_offset
                .ok_or("The installed copy is absent from its original observation")?;
            check(
                next > offset && next <= 10000,
                "Invalid installed-copy continuation",
            )?;
            offset = next;
        }
    }
}
fn preview(
    owner: &InstanceRef,
    request: PreviewContext,
    source: &Source,
    page: &PackageSnapshotData,
    copy: &PackageEntry,
) -> Result<ContextPreview, String> {
    check(source.matches(copy), "Installed copy changed identity")?;
    let text = format!(
        "Installed package: {} {}\nLibrary: {}\nNative session: {}\nObservation: {} · observed at {}\nObserved installed-copy metadata:\n{}\nInventory scan complete: {}\nNotices: {}\nSource fields are recorded evidence; missing installation provenance stays unknown. Viewing does not install, load or attach this package.",
        source.package,
        source.version,
        source.library,
        source.session,
        source.observation,
        page.observed_at_ms,
        serde_json::to_string_pretty(copy).map_err(|e| e.to_string())?,
        page.scan_complete,
        json!(page.notices)
    );
    let (text, truncated) = bounded_text(&text, request.max_bytes.min(16384) as usize);
    let preview = ContextPreview {
        item: source.item(owner, &request.reference.window)?,
        text,
        truncated,
        data: json!({"inclusion":"metadata","observation":source.observation,"native_session":source.session,"observed_at_ms":page.observed_at_ms,"scan_complete":page.scan_complete,"notices":page.notices}),
        resources: vec![],
    };
    check(
        preview.item.reference == request.reference,
        "Installed-copy preview changed its reference",
    )?;
    preview.validate().map_err(|e| e.to_string())?;
    Ok(preview)
}
#[cfg(test)]
mod tests;
