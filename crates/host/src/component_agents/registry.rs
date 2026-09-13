use super::*;

pub(super) struct RegisteredTool {
    pub descriptor: CapabilityDescriptor,
    pub spec: ComponentToolSpec,
    hidden: Vec<String>,
    model_validator: jsonschema::Validator,
    native_validator: jsonschema::Validator,
    document_action: Option<&'static str>,
}
impl RegisteredTool {
    pub fn invalid_arguments_feedback(&self, arguments: &Value) -> Option<Value> {
        if self.model_validator.is_valid(arguments) {
            return None;
        }
        let properties = self.spec.parameters["properties"].as_object();
        // Attempts to override a hidden identity are terminal, not format repair.
        if arguments.as_object().is_some_and(|args| {
            args.keys().any(|key| {
                properties.is_none_or(|p| !p.contains_key(key))
                    && matches!(
                        key.as_str(),
                        "window"
                            | "workspace_instance_id"
                            | "expected_session"
                            | "session_id"
                            | "only_operation_ids"
                            | "execution_target"
                            | "request_id"
                            | "document"
                            | "target_path"
                    )
            })
        }) {
            return None;
        }
        Some(
            json!({"status":"rejected","accepted":false,"error":"Tool arguments do not match the offered schema. Correct them within the remaining request budget.","tool":self.spec.name,"parameters":self.spec.parameters}),
        )
    }
    pub fn bind(
        &self,
        run: &ComponentAgentRun,
        arguments: Value,
    ) -> Result<ComponentToolAction, ApplicationError> {
        if !self.model_validator.is_valid(&arguments) {
            return Err(error("Tool parameters do not match the allowed schema"));
        }
        if let Some(kind) = self.document_action {
            let id = arguments["document_id"]
                .as_str()
                .ok_or_else(|| error("Document identity is required"))?;
            let grant = run
                .request
                .grant
                .documents
                .iter()
                .find(|grant| grant.document.document_id == id)
                .ok_or_else(|| error("Document is outside this request"))?;
            let document = component_document_reference(run, id)
                .ok_or_else(|| error("Document version is unavailable"))?;
            let mut action = arguments
                .as_object()
                .cloned()
                .ok_or_else(|| error("Document arguments must be an object"))?;
            action.remove("document_id");
            action.insert("kind".into(), json!(kind));
            action.insert("document".into(), json!(document));
            if matches!(kind, "save" | "run_file") {
                action.insert("target_path".into(), json!(grant.path));
            }
            let execution_target = if matches!(kind, "run_file" | "run_selection") {
                let session = run
                    .request
                    .grant
                    .session
                    .as_ref()
                    .ok_or_else(|| error("Execution session is not bound"))?;
                Some(ApplicationExecutionTarget {
                    workspace_instance_id: session.workspace_instance_id.clone(),
                    native_session_id: session.session_id.clone(),
                })
            } else {
                None
            };
            let request = ApplicationCommandRequest {
                window: run.request.window.clone(),
                request_id: "component-prepared".into(),
                action: serde_json::from_value(Value::Object(action)).map_err(error)?,
                execution_target,
            };
            if !self
                .native_validator
                .is_valid(&serde_json::to_value(&request).map_err(error)?)
            {
                return Err(error("Bound document action violates the native schema"));
            }
            return Ok(ComponentToolAction::Control(request));
        }
        let mut args = arguments
            .as_object()
            .cloned()
            .ok_or_else(|| error("Tool arguments must be an object"))?;
        for field in &self.hidden {
            if args.contains_key(field) {
                return Err(error("Model cannot override a Host-bound target"));
            }
            let value = match field.as_str() {
                "window" => serde_json::to_value(&run.request.window).map_err(error)?,
                "workspace_instance_id" => json!(
                    run.request
                        .grant
                        .session
                        .as_ref()
                        .ok_or_else(|| error("R instance is not bound"))?
                        .workspace_instance_id
                ),
                "session_id" => json!(
                    run.request
                        .grant
                        .session
                        .as_ref()
                        .ok_or_else(|| error("Native session is not bound"))?
                        .session_id
                ),
                "only_operation_ids" => json!([]),
                "expected_session" => json!(
                    run.request
                        .grant
                        .session
                        .as_ref()
                        .ok_or_else(|| error("Native session is not bound"))?
                        .session_id
                ),
                _ => return Err(error("Unknown trusted tool binding")),
            };
            args.insert(field.clone(), value);
        }
        let arguments = Value::Object(args);
        if !self.native_validator.is_valid(&arguments) {
            return Err(error("Bound tool arguments violate the native schema"));
        }
        if self.descriptor.kind == CapabilityKind::Operation {
            let session = run
                .request
                .grant
                .session
                .as_ref()
                .ok_or_else(|| error("R session is not bound"))?;
            Ok(ComponentToolAction::Invoke(Invocation {
                client_request_id: "component-prepared".into(),
                capability: self.descriptor.capability.clone(),
                arguments,
                preconditions: vec![Precondition {
                    kind: "workspace.session".into(),
                    subject: "active".into(),
                    expected: json!(session.session_id),
                }],
            }))
        } else {
            Ok(ComponentToolAction::Query(QueryRequest {
                capability: self.descriptor.capability.clone(),
                arguments,
            }))
        }
    }
}

fn expanded(value: &Value, root: &Value, depth: usize) -> Result<Value, ApplicationError> {
    if depth > 32 {
        return Err(error("Tool schema nesting exceeds the projection limit"));
    }
    match value {
        Value::Object(map) => {
            if let Some(reference) = map.get("$ref").and_then(Value::as_str) {
                let pointer = reference
                    .strip_prefix('#')
                    .ok_or_else(|| error("Only local schema references are supported"))?;
                let target = root
                    .pointer(pointer)
                    .ok_or_else(|| error("Unresolved native schema reference"))?;
                let mut resolved = expanded(target, root, depth + 1)?;
                if let Some(object) = resolved.as_object_mut() {
                    for (key, value) in map {
                        if key != "$ref" {
                            object.insert(key.clone(), expanded(value, root, depth + 1)?);
                        }
                    }
                }
                return Ok(resolved);
            }
            let mut result = serde_json::Map::new();
            for (key, value) in map {
                if !matches!(key.as_str(), "$defs" | "$schema" | "title" | "examples") {
                    result.insert(key.clone(), expanded(value, root, depth + 1)?);
                }
            }
            Ok(Value::Object(result))
        }
        Value::Array(values) => Ok(Value::Array(
            values
                .iter()
                .map(|v| expanded(v, root, depth + 1))
                .collect::<Result<_, _>>()?,
        )),
        value => Ok(value.clone()),
    }
}

fn find_action(value: &Value, kind: &str) -> Option<Value> {
    if value["properties"]["kind"]["const"] == kind {
        return Some(value.clone());
    }
    for alternatives in ["oneOf", "anyOf"] {
        for variant in value[alternatives].as_array().into_iter().flatten() {
            if let Some(found) = find_action(variant, kind) {
                return Some(found);
            }
        }
    }
    None
}

pub(super) fn registered_tools(
    host: &NextHost,
    context: &CallContext,
    run: &ComponentAgentRun,
) -> Result<BTreeMap<String, RegisteredTool>, ApplicationError> {
    let mut registered = BTreeMap::new();
    for descriptor in host.capabilities_for(context) {
        if descriptor.kind == CapabilityKind::Control
            && descriptor.capability.id == "application.control"
            && run.request.grant.mode != ComponentAgentMode::Explain
        {
            let native = expanded(&descriptor.input_schema, &descriptor.input_schema, 0)?;
            for (kind, name) in [
                ("edit_document", "application_edit_document"),
                ("save", "application_save_document"),
                ("run_file", "application_run_file"),
                ("run_selection", "application_run_selection"),
            ] {
                let execute = matches!(kind, "run_file" | "run_selection");
                let save = matches!(kind, "save" | "run_file");
                if execute && run.request.grant.mode != ComponentAgentMode::Run {
                    continue;
                }
                let ids: Vec<_> = run
                    .request
                    .grant
                    .documents
                    .iter()
                    .filter(|g| !save || g.allow_save)
                    .map(|g| g.document.document_id.clone())
                    .collect();
                if ids.is_empty() {
                    continue;
                }
                let mut descriptor = descriptor.clone();
                if save {
                    descriptor.required_scopes.insert("project.write".into());
                }
                if execute {
                    descriptor.required_scopes.insert("workspace.run_r".into());
                }
                if !descriptor.required_scopes.is_subset(&context.scopes) {
                    continue;
                }
                let mut parameters = find_action(&native["properties"]["action"], kind)
                    .ok_or_else(|| error("Native application action schema is unavailable"))?;
                let properties = parameters
                    .get_mut("properties")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| error("Application action schema is not an object"))?;
                for hidden in ["kind", "document", "target_path"] {
                    properties.remove(hidden);
                }
                properties.insert("document_id".into(), json!({"type":"string","enum":ids}));
                let required = parameters
                    .get_mut("required")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| error("Application action fields are unavailable"))?;
                required
                    .retain(|v| !matches!(v.as_str(), Some("kind" | "document" | "target_path")));
                required.push(json!("document_id"));
                parameters["additionalProperties"] = json!(false);
                let spec = ComponentToolSpec {
                    name: name.into(),
                    description: format!(
                        "{} within this request's fixed document and execution scope",
                        kind.replace('_', " ")
                    ),
                    parameters: parameters.clone(),
                };
                let model_validator = jsonschema::validator_for(&parameters).map_err(error)?;
                let native_validator =
                    jsonschema::validator_for(&descriptor.input_schema).map_err(error)?;
                registered.insert(
                    name.into(),
                    RegisteredTool {
                        descriptor,
                        spec,
                        hidden: vec![],
                        model_validator,
                        native_validator,
                        document_action: Some(kind),
                    },
                );
            }
            continue;
        }
        let run_r = descriptor.kind == CapabilityKind::Operation
            && descriptor.capability.id == "workspace.run_r"
            && run.request.grant.mode == ComponentAgentMode::Run
            && matches!(
                run.profile,
                ComponentAgentProfile::Workspace | ComponentAgentProfile::Project
            );
        let resume = descriptor.kind == CapabilityKind::Operation
            && descriptor.capability.id == "workspace.resume_queue"
            && run.request.grant.mode == ComponentAgentMode::Run
            && matches!(
                run.profile,
                ComponentAgentProfile::Documents
                    | ComponentAgentProfile::Workspace
                    | ComponentAgentProfile::Project
            );
        if !run_r
            && !resume
            && (descriptor.kind != CapabilityKind::Query
                || !component_query_allowed(run.profile, &descriptor.capability.id))
        {
            continue;
        }
        let mut parameters = expanded(&descriptor.input_schema, &descriptor.input_schema, 0)?;
        let properties = parameters
            .get_mut("properties")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| error("Native tool schema is not an object"))?;
        let mut hidden: Vec<String> = Vec::new();
        if run.request.grant.session.is_none()
            && (properties.contains_key("workspace_instance_id")
                || properties.contains_key("expected_session"))
        {
            continue;
        }
        let mut fields = vec!["window", "workspace_instance_id", "expected_session"];
        if resume {
            fields.extend(["session_id", "only_operation_ids"]);
        }
        for name in fields {
            if properties.remove(name).is_some() {
                hidden.push(name.into());
            }
        }
        if let Some(required) = parameters.get_mut("required").and_then(Value::as_array_mut) {
            required.retain(|field| {
                !hidden
                    .iter()
                    .any(|name| field.as_str() == Some(name.as_str()))
            });
        }
        parameters["additionalProperties"] = json!(false);
        let name = descriptor.capability.id.replace('.', "_");
        if registered.contains_key(&name) {
            return Err(error(
                "Native capability names collide after provider encoding",
            ));
        }
        let spec = ComponentToolSpec {
            name: name.clone(),
            description: descriptor.documentation.summary.clone(),
            parameters: parameters.clone(),
        };
        let model_validator = jsonschema::validator_for(&parameters).map_err(error)?;
        let native_validator =
            jsonschema::validator_for(&descriptor.input_schema).map_err(error)?;
        registered.insert(
            name,
            RegisteredTool {
                descriptor,
                spec,
                hidden,
                model_validator,
                native_validator,
                document_action: None,
            },
        );
    }
    Ok(registered)
}
