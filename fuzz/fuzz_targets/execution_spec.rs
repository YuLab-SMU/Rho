#![no_main]

use std::collections::BTreeSet;

use libfuzzer_sys::fuzz_target;
use rho_protocol::{MAX_EXECUTION_SPEC_BYTES, decode_execution_spec_v1};

fuzz_target!(|data: &[u8]| {
    if data.len() > MAX_EXECUTION_SPEC_BYTES + 1 {
        return;
    }
    if let Ok(spec) = decode_execution_spec_v1(data, &BTreeSet::new()) {
        spec.validate(&BTreeSet::new())
            .expect("successful parse remains valid");
        let _ = spec.digest(&BTreeSet::new()).expect("validated spec hashes");
    }
});
