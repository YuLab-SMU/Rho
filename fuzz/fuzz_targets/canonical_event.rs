#![no_main]

use libfuzzer_sys::fuzz_target;
use rho_protocol::{MAX_SEMANTIC_EVENT_PAYLOAD_BYTES, SemanticEvent};

fuzz_target!(|data: &[u8]| {
    if data.len() > MAX_SEMANTIC_EVENT_PAYLOAD_BYTES * 2 {
        return;
    }
    if let Ok(event) = serde_json::from_slice::<SemanticEvent>(data) {
        let _ = event.validate();
    }
});
