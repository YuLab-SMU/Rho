//! Bounded editor-text matching; the normal command still performs the actual edit.
use super::*;
pub enum ApplicationTextMatch {
    Unique(ApplicationTextEdit),
    Missing,
    Ambiguous,
}
impl ApplicationOwner {
    pub fn prepare_text_replacement(
        &self,
        context: &CallContext,
        window: &ApplicationWindowRef,
        reference: &ApplicationDocumentRef,
        old_text: &str,
        new_text: &str,
        now: u64,
    ) -> Result<ApplicationTextMatch, ApplicationError> {
        let _guard = self.lock()?;
        let scope = self.scope(context)?;
        let current = self.load_window(&scope, window)?;
        self.require_online(&current, now)?;
        let document = self.find_document(&scope, &window.window_id, reference)?;
        if document.readonly_reason.is_some() {
            return Err(invalid("The document is read-only"));
        }
        if old_text.is_empty()
            || old_text.len() > 32768
            || new_text.len() > 32768
            || old_text.contains('\0')
            || new_text.contains('\0')
        {
            return Err(invalid(
                "Text replacement requires a nonempty bounded UTF-8 match without NUL bytes",
            ));
        }
        let text = editor_text(&document.text);
        let needle = editor_text(old_text);
        if needle.is_empty() {
            return Err(invalid("The editor match must not be empty"));
        }
        let Some(start) = text.find(&needle) else {
            return Ok(ApplicationTextMatch::Missing);
        };
        let next = start + text[start..].chars().next().unwrap().len_utf8();
        if text[next..].contains(&needle) {
            return Ok(ApplicationTextMatch::Ambiguous);
        }
        let from = text[..start].encode_utf16().count() as u32;
        let to = from + needle.encode_utf16().count() as u32;
        Ok(ApplicationTextMatch::Unique(ApplicationTextEdit {
            from,
            to,
            insert: new_text.replace("\r\n", "\n").replace('\r', "\n"),
        }))
    }
}
