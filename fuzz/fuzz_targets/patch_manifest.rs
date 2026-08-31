#![no_main]

use libfuzzer_sys::fuzz_target;
use rho_protocol::{MAX_PATCH_BYTES, decode_canonical_patch};

fuzz_target!(|data: &[u8]| {
    if data.len() > MAX_PATCH_BYTES + 1 {
        return;
    }
    if let Ok(patch) = decode_canonical_patch(data) {
        patch.validate().expect("successful parse remains valid");
        let summary = patch.exact_effect_summary();
        assert!(summary.paths.len() <= rho_protocol::MAX_PATCH_OPERATIONS * 2);
        // Parsing never calls BrokerProjectCommitter or touches a filesystem.
    }
});
