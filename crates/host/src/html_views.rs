//! Short-lived view tokens for retained HTML artifacts. A token names one verified
//! output within one project; it carries no Studio bearer and expires on its own.
use rho_contract::*;
use rho_operation::OperationError;
use std::collections::HashMap;
use std::sync::Mutex;

pub const HTML_VIEW_TOKEN_TTL_MS: u64 = 15 * 60 * 1000;
const MAX_TOKENS: usize = 512;
const MAX_HTML_BYTES: u64 = 16 * 1024 * 1024;

struct Minted {
    project: String,
    reference: MediaReference,
    expires_at_ms: u64,
}

#[derive(Default)]
pub struct HtmlViewTokens {
    tokens: Mutex<HashMap<String, Minted>>,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

pub fn surface_type(html: &[u8]) -> HtmlSurfaceType {
    let head = &html[..html.len().min(256 * 1024)];
    let text = String::from_utf8_lossy(head);
    if text.contains("HTMLWidgets") || text.contains("htmlwidget") {
        HtmlSurfaceType::HtmlWidget
    } else {
        HtmlSurfaceType::StaticHtml
    }
}

impl HtmlViewTokens {
    /// Verify the artifact through its owner, then mint a token for it.
    pub async fn mint(
        &self,
        host: &crate::NextHost,
        context: &CallContext,
        project: &str,
        reference: &MediaReference,
    ) -> Result<HtmlViewToken, OperationError> {
        if reference.mime_type != "text/html" {
            return Err(OperationError::InvalidInput("Only text/html outputs open in the Viewer".into()));
        }
        if reference.byte_size > MAX_HTML_BYTES {
            return Err(OperationError::BudgetExceeded("HTML output exceeds 16 MiB".into()));
        }
        let bytes = host.verified_output(context, reference).await?;
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let expires_at_ms = now() + HTML_VIEW_TOKEN_TTL_MS;
        {
            let mut tokens = self.tokens.lock().map_err(|_| OperationError::Storage("view token store poisoned".into()))?;
            let current = now();
            tokens.retain(|_, minted| minted.expires_at_ms > current);
            if tokens.len() >= MAX_TOKENS {
                return Err(OperationError::BudgetExceeded("Too many open HTML views; close some views first".into()));
            }
            tokens.insert(token.clone(), Minted { project: project.into(), reference: reference.clone(), expires_at_ms });
        }
        Ok(HtmlViewToken {
            surface: HtmlSurfaceRef {
                surface_id: format!("{}:{}", reference.operation_id.as_str(), reference.sequence),
                surface_type: surface_type(&bytes),
                state: HtmlSurfaceState::Saved,
                reference: reference.clone(),
                session_id: None,
            },
            path: format!("/view/html/{token}"),
            expires_at_ms,
        })
    }

    /// Resolve a token to its artifact reference for the current project only.
    pub fn resolve(&self, project: &str, token: &str) -> Option<MediaReference> {
        let tokens = self.tokens.lock().ok()?;
        let minted = tokens.get(token)?;
        (minted.project == project && minted.expires_at_ms > now()).then(|| minted.reference.clone())
    }
}
