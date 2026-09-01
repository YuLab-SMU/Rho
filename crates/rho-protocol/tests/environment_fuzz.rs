use proptest::prelude::*;
use rho_protocol::{decode_execution_profile_v1, decode_materialized_package_plan_v1};

proptest! {
    #[test]
    fn environment_plan_and_profile_decoders_never_panic(
        bytes in proptest::collection::vec(any::<u8>(), 0..16_384),
    ) {
        let plan = std::panic::catch_unwind(|| decode_materialized_package_plan_v1(&bytes));
        let profile = std::panic::catch_unwind(|| decode_execution_profile_v1(&bytes));
        prop_assert!(plan.is_ok());
        prop_assert!(profile.is_ok());
    }
}
