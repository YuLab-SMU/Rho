use super::*;
#[async_trait]
pub trait MethodBindingPort: Send + Sync {
    async fn method_bindings(
        &self,
        context: &CallContext,
    ) -> Result<Vec<ApplicationMethodBinding>, String>;
    async fn record_skill_read(
        &self,
        context: &CallContext,
        receipt: &ApplicationSkillReadReceipt,
    ) -> Result<(), String>;
}
#[async_trait]
pub trait SkillCapabilityPort: Send + Sync {
    async fn target_is_current(
        &self,
        context: &CallContext,
        target: &TargetRef,
    ) -> Result<bool, String>;
    /// Permission-filtered native availability, not inferred from Skill prose.
    async fn available_capabilities(
        &self,
        context: &CallContext,
        target: Option<&TargetRef>,
    ) -> Result<Vec<CapabilityRef>, String>;
}
impl SkillOwner {
    /// Validate a proposed application binding immediately before its CAS write.
    /// Application CAS remains authoritative; this does not mutate or continue scientific work.
    pub async fn validate_binding(
        &self,
        context: &CallContext,
        binding: &ApplicationMethodBinding,
    ) -> Result<(), OperationError> {
        let scope = self.scope(context, &binding.working_directory)?;
        if binding.excluded {
            return Ok(());
        }
        let (skills, _) = self.discover(&scope).await?;
        let previous = self
            .bindings
            .method_bindings(context)
            .await
            .map_err(OperationError::Unavailable)?;
        let applicable: Vec<_> = previous
            .iter()
            .filter(|b| {
                b.binding_id != binding.binding_id
                    && ancestor(&b.working_directory, &binding.working_directory)
                    && b.external_task_ref
                        .as_ref()
                        .is_none_or(|task| Some(task) == binding.external_task_ref.as_ref())
            })
            .collect();
        let available = self
            .capabilities
            .available_capabilities(context, binding.target.as_ref())
            .await
            .map_err(OperationError::Unavailable)?;
        let current = match binding.target.as_ref() {
            Some(target) => self
                .capabilities
                .target_is_current(context, target)
                .await
                .map_err(OperationError::Unavailable)?,
            None => true,
        };
        let resolution = binding_resolution(
            binding,
            &applicable,
            &skills,
            &available,
            binding.target.as_ref(),
            current,
        );
        if !resolution.valid {
            return Err(OperationError::InvalidInput(format!(
                "Method binding cannot be selected: {}",
                resolution
                    .conditions
                    .iter()
                    .map(|c| format!("{}: {}", c.code, c.message))
                    .collect::<Vec<_>>()
                    .join("; ")
            )));
        }
        Ok(())
    }
    pub async fn resolve_context(
        &self,
        context: &CallContext,
        args: &ResolveContextArguments,
    ) -> Result<ResolvedSkillContext, OperationError> {
        let scope = self.scope(context, &args.working_directory)?;
        let (skills, notices) = self.discover(&scope).await?;
        let discoverable = list_page(
            &scope,
            &SkillListArguments {
                working_directory: args.working_directory.clone(),
                filter: String::new(),
                source_id: None,
                cursor: args.cursor.clone(),
                limit: args.limit,
            },
            &skills,
            notices,
        )?;
        let bindings = self
            .bindings
            .method_bindings(context)
            .await
            .map_err(OperationError::Unavailable)?;
        if bindings.len() > 2000 {
            return Err(OperationError::BudgetExceeded(
                "Application method bindings exceed 2000 entries; reduce the application scope"
                    .into(),
            ));
        }
        let applicable: Vec<_> = bindings
            .iter()
            .filter(|b| {
                ancestor(&b.working_directory, &args.working_directory)
                    && b.external_task_ref
                        .as_ref()
                        .is_none_or(|task| Some(task) == args.external_task_ref.as_ref())
            })
            .collect();
        let available = self
            .capabilities
            .available_capabilities(context, args.target.as_ref())
            .await
            .map_err(OperationError::Unavailable)?;
        let target_current = match args.target.as_ref() {
            Some(target) => self
                .capabilities
                .target_is_current(context, target)
                .await
                .map_err(OperationError::Unavailable)?,
            None => true,
        };
        let methods = applicable
            .iter()
            .map(|binding| {
                binding_resolution(
                    binding,
                    &applicable,
                    &skills,
                    &available,
                    args.target.as_ref(),
                    target_current,
                )
            })
            .collect();
        let result=ResolvedSkillContext {working_directory:args.working_directory.clone(),external_task_ref:args.external_task_ref.clone(),target:args.target.clone(),discoverable,methods,bindings_complete:true,dependencies:"undeclared unless explicitly recorded as required_capabilities in application metadata".into(),notices:vec!["Selections are caller declarations. They do not prove an Agent followed a method; scientific conclusions still require evidence.".into(),"Resolving context never selects a method, changes a target, submits work, or rewrites an accepted request.".into()]};
        if serde_json::to_vec(&result).map_err(invalid)?.len() > 256 * 1024 {
            return Err(OperationError::BudgetExceeded("Resolved application bindings exceed 256 KiB; narrow external_task_ref or working_directory".into()));
        }
        Ok(result)
    }
}
fn ancestor(parent: &str, child: &str) -> bool {
    parent == "."
        || parent == child
        || child
            .strip_prefix(parent)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn binding_resolution(
    binding: &ApplicationMethodBinding,
    applicable: &[&ApplicationMethodBinding],
    skills: &[DiscoveredSkill],
    available: &[CapabilityRef],
    selected_target: Option<&TargetRef>,
    target_current: bool,
) -> MethodResolution {
    let mut conditions = vec![];
    let mut add = |code: &str, message: &str, capability: Option<CapabilityRef>| {
        conditions.push(MethodCondition {
            binding_id: binding.binding_id.clone(),
            code: code.into(),
            message: message.into(),
            capability,
        })
    };
    let skill = skills
        .iter()
        .find(|s| s.summary.source.source_ref == binding.source_ref);
    if !binding.excluded {
        if !target_current {
            add(
                "target_unavailable",
                "The selected native target is no longer current",
                None,
            );
        }
        if applicable.iter().any(|other| {
            other.excluded
                && other.source_ref == binding.source_ref
                && ancestor(&other.working_directory, &binding.working_directory)
        }) {
            add(
                "excluded_by_ancestor",
                "An explicit ancestor exclusion must be cleared at its original scope before selection can take effect",
                None,
            );
        }
        match skill {
            None => add(
                "source_unavailable",
                "Selected method source is no longer discoverable in this project/workdir",
                None,
            ),
            Some(skill) => {
                if !skill.summary.available {
                    add(
                        "host_disabled",
                        "The originating host disabled or rejected this method; a Rho binding cannot enable it",
                        None,
                    );
                }
                if skill.summary.skill_ref != binding.skill_ref {
                    add(
                        "skill_changed",
                        "Skill body, resources or source state changed after selection",
                        None,
                    );
                }
                for resource in &binding.resources {
                    let current = skill.package.resources.iter().find(|r| {
                        format!("{}#{}", skill.summary.source.source_ref, r.path)
                            == resource.resource_ref
                    });
                    if current.is_none_or(|r| r.sha256 != resource.sha256) {
                        add(
                            "resource_changed",
                            "A resource pinned by this binding is absent or changed",
                            None,
                        );
                    }
                }
            }
        }
        if binding
            .target
            .as_ref()
            .is_some_and(|target| Some(target) != selected_target)
        {
            add(
                "target_mismatch",
                "Selected method is bound to a different native execution target",
                None,
            );
        }
        for capability in &binding.required_capabilities {
            if !available.contains(capability) {
                add(
                    "capability_unavailable",
                    "An explicitly declared required capability is unavailable for this caller/target",
                    Some(capability.clone()),
                );
            }
        }
    }
    MethodResolution {
        binding: binding.clone(),
        binding_id: binding.binding_id.clone(),
        version: binding.version.clone(),
        source_ref: binding.source_ref.clone(),
        skill_ref: binding.skill_ref.clone(),
        excluded: binding.excluded,
        valid: conditions.is_empty() && !binding.excluded,
        target: binding.target.clone(),
        conditions,
    }
}
