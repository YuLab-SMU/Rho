#![no_main]

use libfuzzer_sys::fuzz_target;
use rho_agent_host::protocol::acp::v1::{AcpV1Codec, MAX_ACP_FRAME_BYTES};

fuzz_target!(|data: &[u8]| {
    if data.len() > MAX_ACP_FRAME_BYTES + 1 {
        return;
    }
    let mut codec = AcpV1Codec::new();
    for chunk in data.chunks(17) {
        if codec.feed(chunk).is_err() {
            return;
        }
    }
    let _ = codec.finish();
    while let Some(event) = codec.pop_event() {
        let encoded = serde_json::to_vec(&event).unwrap_or_default();
        assert!(encoded.len() <= MAX_ACP_FRAME_BYTES * 2);
    }
});
