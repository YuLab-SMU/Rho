use super::*;

pub(crate) fn validate_id(value: &str) -> Result<(), ApplicationError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-:/".contains(&b))
    {
        return Err(invalid("identity must be 1..160 ASCII token bytes"));
    }
    Ok(())
}
pub(crate) fn validate_window(window: &ApplicationWindowRef) -> Result<(), ApplicationError> {
    validate_id(&window.window_id)?;
    validate_id(&window.incarnation)
}
fn validate_view_id(value: &str) -> Result<(), ApplicationError> {
    // Existing object viewers use `object:<exact R name>` as their view identity.
    // Preserve Unicode and spaces rather than turning a scientific name into a token.
    if value.is_empty() || value.len() > 2048 || value.contains('\0') {
        return Err(invalid(
            "view identity must be 1..2048 UTF-8 bytes without NUL",
        ));
    }
    Ok(())
}
pub(crate) fn validate_path(value: &str) -> Result<(), ApplicationError> {
    if value.is_empty()
        || value.len() > 1024
        || value.starts_with('/')
        || value
            .chars()
            .any(|c| c.is_control() || matches!(c, '\\' | ':'))
        || value.split('/').any(|p| {
            p.is_empty()
                || p == "."
                || p == ".."
                || p.eq_ignore_ascii_case(".git")
                || p.eq_ignore_ascii_case(".rho")
        })
    {
        return Err(invalid(
            "use a contained project-relative path without private .git/.rho components",
        ));
    }
    Ok(())
}
pub(crate) fn validate_relative_directory(value: &str) -> Result<(), ApplicationError> {
    if value == "." {
        Ok(())
    } else {
        validate_path(value)
    }
}
pub(crate) fn editor_text(raw: &str) -> String {
    raw.strip_prefix('\u{feff}')
        .unwrap_or(raw)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}
pub(crate) fn utf16_offset(text: &str, offset: u32) -> Result<usize, ApplicationError> {
    let mut units = 0;
    for (byte, character) in text.char_indices() {
        if units == offset {
            return Ok(byte);
        }
        units += character.len_utf16() as u32;
        if units > offset {
            return Err(invalid("UTF-16 offset splits a surrogate pair"));
        }
    }
    if units == offset {
        Ok(text.len())
    } else {
        Err(invalid("UTF-16 offset exceeds document length"))
    }
}
pub(crate) fn check_document_ref(
    document: &ApplicationDocument,
    reference: &ApplicationDocumentRef,
) -> Result<(), ApplicationError> {
    if document.document_id != reference.document_id
        || document.version != reference.document_version
        || document.selection.version != reference.selection_version
    {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}
pub(crate) fn validate_document(document: &ApplicationDocument) -> Result<(), ApplicationError> {
    validate_id(&document.document_id)?;
    validate_id(&document.version)?;
    validate_id(&document.selection.version)?;
    if let Some(path) = &document.path {
        validate_path(path)?;
    }
    if document.text.len() > MAX_DOCUMENT_BYTES
        || document
            .base_text
            .as_ref()
            .is_some_and(|s| s.len() > MAX_DOCUMENT_BYTES)
    {
        return Err(ApplicationError::Budget(
            "document/base text exceeds 512 KiB".into(),
        ));
    }
    if document.text.contains('\0')
        || document
            .base_text
            .as_ref()
            .is_some_and(|s| s.contains('\0'))
    {
        return Err(invalid("drafts contain UTF-8 text, not NUL bytes"));
    }
    match (&document.base_text, &document.base_hash) {
        (None, None) => (),
        (Some(text), Some(hash)) if sha256(text) == *hash => (),
        _ if document.readonly_reason.is_some() && document.base_text.is_none() => (),
        _ => return Err(invalid("base_hash must identify the exact base_text")),
    }
    let editor = editor_text(&document.text);
    utf16_offset(&editor, document.selection.anchor)?;
    utf16_offset(&editor, document.selection.head)?;
    if document
        .readonly_reason
        .as_ref()
        .is_some_and(|s| s.len() > 4096)
    {
        return Err(invalid("readonly reason exceeds 4096 bytes"));
    }
    Ok(())
}
pub(crate) fn validate_context(
    context: &ApplicationContextState,
    documents: &[ApplicationDocument],
) -> Result<(), ApplicationError> {
    validate_id(&context.version)?;
    if context.label.len() > 256 || context.views.len() > 64 {
        return Err(ApplicationError::Budget(
            "context allows 64 views and a 256-byte label".into(),
        ));
    }
    if context
        .active_document_id
        .as_ref()
        .is_some_and(|id| !documents.iter().any(|d| &d.document_id == id))
    {
        return Err(invalid("active document does not exist"));
    }
    let mut ids = std::collections::BTreeSet::new();
    for view in &context.views {
        validate_view_id(&view.view_id)?;
        if !ids.insert(&view.view_id) {
            return Err(invalid("view ID occurs more than once"));
        }
        if view
            .document_id
            .as_ref()
            .is_some_and(|id| !documents.iter().any(|d| &d.document_id == id))
        {
            return Err(invalid("view refers to a missing document"));
        }
    }
    if context
        .active_view_id
        .as_ref()
        .is_some_and(|id| !context.views.iter().any(|v| &v.view_id == id))
    {
        return Err(invalid("active view does not exist"));
    }
    if let Some(session) = &context.native_session_id {
        validate_id(session)?;
    }
    if let Some(object) = &context.selected_object {
        validate_object(object, context)?;
    }
    if let Some(package) = &context.selected_package {
        validate_package(package, context)?;
    }
    Ok(())
}
fn validate_object(
    selection: &ApplicationObjectSelection,
    context: &ApplicationContextState,
) -> Result<(), ApplicationError> {
    if selection.name.is_empty() || selection.name.len() > 1024 {
        return Err(invalid("object name must be 1..1024 UTF-8 bytes"));
    }
    validate_id(&selection.native_session_id)?;
    if context.native_session_id.as_ref() != Some(&selection.native_session_id) {
        return Err(ApplicationError::Conflict);
    }
    if let Some(reference) = &selection.object_ref {
        validate_id(reference)?;
    }
    Ok(())
}
fn validate_package(
    selection: &ApplicationPackageSelection,
    context: &ApplicationContextState,
) -> Result<(), ApplicationError> {
    validate_id(&selection.package)?;
    validate_id(&selection.native_session_id)?;
    // Native copy identities may contain full paths; they are data, not paths opened here.
    if selection.copy_id.is_empty()
        || selection.copy_id.len() > 4096
        || selection.observation_id.is_empty()
        || selection.observation_id.len() > 160
    {
        return Err(invalid("package observation/copy identity is invalid"));
    }
    if context.native_session_id.as_ref() != Some(&selection.native_session_id) {
        return Err(ApplicationError::Conflict);
    }
    Ok(())
}
pub(crate) fn validate_action(
    action: &ApplicationAction,
    context: &ApplicationContextState,
    documents: &[ApplicationDocument],
) -> Result<(), ApplicationError> {
    let expected_context = match action {
        ApplicationAction::OpenView {
            expected_context_version,
            ..
        }
        | ApplicationAction::ActivateView {
            expected_context_version,
            ..
        }
        | ApplicationAction::CloseView {
            expected_context_version,
            ..
        }
        | ApplicationAction::OpenDocument {
            expected_context_version,
            ..
        }
        | ApplicationAction::CreateDocument {
            expected_context_version,
            ..
        }
        | ApplicationAction::SelectObject {
            expected_context_version,
            ..
        }
        | ApplicationAction::SelectPackage {
            expected_context_version,
            ..
        }
        | ApplicationAction::SelectPlot {
            expected_context_version,
            ..
        } => Some(expected_context_version),
        _ => None,
    };
    if expected_context.is_some_and(|v| v != &context.version) {
        return Err(ApplicationError::Conflict);
    }
    match action {
        ApplicationAction::OpenView {
            view_type, view_id, ..
        } => {
            if let Some(id) = view_id {
                validate_view_id(id)?;
            }
            if matches!(
                view_type,
                ApplicationViewType::Document | ApplicationViewType::Viewer
            ) {
                return Err(invalid(
                    "open documents through open_document; object viewers require an existing identified view",
                ));
            }
        }
        ApplicationAction::ActivateView { view_id, .. }
        | ApplicationAction::CloseView { view_id, .. } => {
            if !context.views.iter().any(|v| &v.view_id == view_id) {
                return Err(ApplicationError::NotFound);
            }
        }
        ApplicationAction::OpenDocument { path, .. } => {
            validate_path(path)?;
            if documents.len() >= MAX_WINDOW_DOCUMENTS
                && !documents.iter().any(|d| d.path.as_ref() == Some(path))
            {
                return Err(ApplicationError::Budget(
                    "64 retained documents per window".into(),
                ));
            }
        }
        ApplicationAction::CreateDocument { path, text, .. } => {
            if documents.len() >= MAX_WINDOW_DOCUMENTS {
                return Err(ApplicationError::Budget(
                    "64 retained documents per window".into(),
                ));
            }
            if let Some(path) = path {
                validate_path(path)?;
                if documents.iter().any(|d| d.path.as_ref() == Some(path)) {
                    return Err(ApplicationError::Conflict);
                }
            }
            if text.len() > MAX_DOCUMENT_BYTES || text.contains('\0') {
                return Err(invalid("new document must be UTF-8 text within 512 KiB"));
            }
        }
        ApplicationAction::SelectObject { selection, .. } => {
            validate_object(selection, context)?;
            if selection.object_ref.is_none() {
                return Err(invalid(
                    "an Agent object selection requires object_ref from workspace.observe_object",
                ));
            }
        }
        ApplicationAction::SelectPackage { selection, .. } => validate_package(selection, context)?,
        ApplicationAction::SelectPlot { .. } => (),
        _ => {
            let reference = match action {
                ApplicationAction::SetSelection { document, .. }
                | ApplicationAction::EditDocument { document, .. }
                | ApplicationAction::Save { document, .. }
                | ApplicationAction::RunSelection { document }
                | ApplicationAction::RunFile { document, .. } => document,
                _ => unreachable!(),
            };
            let document = documents
                .iter()
                .find(|d| d.document_id == reference.document_id)
                .ok_or(ApplicationError::NotFound)?;
            check_document_ref(document, reference)?;
            let editor = editor_text(&document.text);
            match action {
                ApplicationAction::SetSelection { anchor, head, .. } => {
                    utf16_offset(&editor, *anchor)?;
                    utf16_offset(&editor, *head)?;
                }
                ApplicationAction::EditDocument { edits, .. } => {
                    if document.readonly_reason.is_some() {
                        return Err(invalid("document is read-only"));
                    }
                    if edits.is_empty() || edits.len() > 200 {
                        return Err(invalid(
                            "edit requires 1..200 ordered, nonoverlapping ranges",
                        ));
                    }
                    let mut end = 0;
                    let mut size = editor.len();
                    for edit in edits {
                        if edit.from < end || edit.to < edit.from || edit.insert.contains('\0') {
                            return Err(invalid(
                                "edits must be ordered nonoverlapping UTF-16 ranges with text",
                            ));
                        }
                        let from = utf16_offset(&editor, edit.from)?;
                        let to = utf16_offset(&editor, edit.to)?;
                        size = size - (to - from) + edit.insert.len();
                        end = edit.to;
                    }
                    if size > MAX_DOCUMENT_BYTES {
                        return Err(ApplicationError::Budget(
                            "edited document exceeds 512 KiB".into(),
                        ));
                    }
                }
                ApplicationAction::Save { target_path, .. }
                | ApplicationAction::RunFile { target_path, .. } => {
                    if document.readonly_reason.is_some() {
                        return Err(invalid("document is read-only"));
                    }
                    let path = target_path
                        .as_ref()
                        .or(document.path.as_ref())
                        .ok_or_else(|| invalid("new documents require an explicit target_path"))?;
                    validate_path(path)?;
                    if document.path.is_some() && document.path.as_ref() != Some(path) {
                        return Err(invalid(
                            "save-as replacement needs its own target file observation; this action saves the captured document path",
                        ));
                    }
                    if documents.iter().any(|d| {
                        d.document_id != document.document_id && d.path.as_ref() == Some(path)
                    }) {
                        return Err(ApplicationError::Conflict);
                    }
                }
                _ => (),
            }
            if matches!(
                action,
                ApplicationAction::RunFile { .. } | ApplicationAction::RunSelection { .. }
            ) {
                if context.native_session_id.is_none() {
                    return Err(invalid("running requires a connected native session"));
                }
                if document.readonly_reason.is_some() {
                    return Err(invalid("document is read-only"));
                }
            }
        }
    }
    Ok(())
}

/// An acknowledgement is not proof that an application action took effect.
/// Verify its authoritative synchronized resources before issuing Applied.
pub(crate) fn validate_applied_state(
    action: &ApplicationAction,
    after: &ApplicationContextState,
    originals: &[ApplicationDocument],
    updates: &ApplicationStoreChanges,
) -> Result<(), ApplicationError> {
    let document = |id: &str| {
        updates
            .documents
            .iter()
            .find(|d| d.document_id == id)
            .or_else(|| originals.iter().find(|d| d.document_id == id))
    };
    let visible = |id: &str| after.views.iter().any(|v| v.view_id == id);
    let valid = match action {
        ApplicationAction::OpenView {
            view_type, view_id, ..
        } => after.views.iter().any(|v| {
            &v.view_type == view_type && view_id.as_ref().is_none_or(|id| &v.view_id == id)
        }),
        ApplicationAction::ActivateView { view_id, .. } => {
            visible(view_id) && after.active_view_id.as_ref() == Some(view_id)
        }
        ApplicationAction::CloseView { view_id, .. } => !visible(view_id),
        ApplicationAction::OpenDocument { path, .. } => after
            .active_document_id
            .as_ref()
            .and_then(|id| document(id))
            .is_some_and(|d| d.path.as_ref() == Some(path)),
        ApplicationAction::CreateDocument { path, text, .. } => updates.documents.iter().any(|d| {
            !originals.iter().any(|old| old.document_id == d.document_id)
                && &d.path == path
                && &d.text == text
                && after.active_document_id.as_ref() == Some(&d.document_id)
        }),
        ApplicationAction::SetSelection {
            document: reference,
            anchor,
            head,
        } => document(&reference.document_id)
            .is_some_and(|d| d.selection.anchor == *anchor && d.selection.head == *head),
        ApplicationAction::EditDocument {
            document: reference,
            edits,
        } => {
            let original = originals
                .iter()
                .find(|d| d.document_id == reference.document_id)
                .ok_or(ApplicationError::NotFound)?;
            // Work in editor UTF-16 coordinates while preserving every untouched
            // raw newline/BOM byte, exactly as the resident Documents owner does.
            let raw = original
                .text
                .strip_prefix('\u{feff}')
                .unwrap_or(&original.text);
            let eol = raw
                .find(['\r', '\n'])
                .map(|index| {
                    if raw[index..].starts_with("\r\n") {
                        "\r\n"
                    } else if raw[index..].starts_with('\r') {
                        "\r"
                    } else {
                        "\n"
                    }
                })
                .unwrap_or("\n");
            let raw_offset = |offset: u32| -> Result<usize, ApplicationError> {
                let mut count = 0;
                let mut chars = raw.char_indices().peekable();
                while let Some((position, ch)) = chars.next() {
                    if count == offset {
                        return Ok(position);
                    }
                    if ch == '\r' && chars.peek().is_some_and(|(_, next)| *next == '\n') {
                        chars.next();
                    }
                    count += ch.len_utf16() as u32;
                    if count > offset {
                        return Err(invalid("edit position splits a surrogate pair"));
                    }
                }
                if count == offset {
                    Ok(raw.len())
                } else {
                    Err(invalid("edit position is outside the capture"))
                }
            };
            let mut expected = String::new();
            if original.text.starts_with('\u{feff}') {
                expected.push('\u{feff}');
            }
            let mut end = 0;
            for edit in edits {
                let from = raw_offset(edit.from)?;
                let to = raw_offset(edit.to)?;
                expected.push_str(&raw[end..from]);
                expected.push_str(
                    &edit
                        .insert
                        .replace("\r\n", "\n")
                        .replace('\r', "\n")
                        .replace('\n', eol),
                );
                end = to;
            }
            expected.push_str(&raw[end..]);
            document(&reference.document_id).is_some_and(|d| d.text == expected)
        }
        ApplicationAction::SelectObject { selection, .. } => {
            after.selected_object.as_ref() == Some(selection)
        }
        ApplicationAction::SelectPackage { selection, .. } => {
            after.selected_package.as_ref() == Some(selection)
        }
        ApplicationAction::SelectPlot { selection, .. } => {
            after.selected_plot.as_ref() == Some(selection)
        }
        // Capture-only local stages do not claim a scientific result.
        ApplicationAction::Save { .. }
        | ApplicationAction::RunFile { .. }
        | ApplicationAction::RunSelection { .. } => true,
    };
    if valid {
        Ok(())
    } else {
        Err(invalid(
            "the synchronized resources do not confirm the requested application action",
        ))
    }
}
