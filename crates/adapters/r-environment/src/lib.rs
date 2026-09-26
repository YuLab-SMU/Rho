//! Transitional Host port; native Environment ownership lives in the package.
#![forbid(unsafe_code)]
use async_trait::async_trait;
use rho_environment::*;
pub use rho_environment_owner::REnvironmentConfig;
use rho_environment_owner::{EnvironmentOwnerError, REnvironmentOwner};
use rho_operation::HandlerError;
use tokio::sync::watch;

pub struct REnvironment {
    owner: REnvironmentOwner,
}
impl REnvironment {
    pub fn open(config: REnvironmentConfig) -> Result<Self, String> {
        Ok(Self {
            owner: REnvironmentOwner::open(config)?,
        })
    }
    pub async fn initialize_observation(&self) -> Result<(), String> {
        self.owner.initialize_observation().await
    }
}
fn error(native: EnvironmentOwnerError) -> HandlerError {
    if native.cancellation_confirmed {
        HandlerError::cancelled(native.message, native.recovery)
    } else if native.possible_effect {
        HandlerError::after_possible_effect(native.message, native.recovery)
    } else {
        HandlerError::before_effect(native.message)
    }
}
#[async_trait]
impl EnvironmentRuntime for REnvironment {
    fn root(&self) -> &str {
        self.owner.root()
    }
    async fn observe(
        &self,
        library: Option<&str>,
        limit: usize,
    ) -> Result<EnvironmentObservation, String> {
        self.owner.observe(library, limit).await
    }
    async fn plan(
        &self,
        operation_id: &str,
        args: &PlanArguments,
        cancellation: watch::Receiver<bool>,
    ) -> Result<EnvironmentPlan, HandlerError> {
        self.owner
            .plan(operation_id, args, cancellation)
            .await
            .map_err(error)
    }
    async fn realize(
        &self,
        operation_id: &str,
        plan_id: &str,
        plan: &EnvironmentPlan,
        cancellation: watch::Receiver<bool>,
    ) -> Result<EnvironmentRealization, HandlerError> {
        self.owner
            .realize(operation_id, plan_id, plan, cancellation)
            .await
            .map_err(error)
    }
    async fn verify(
        &self,
        operation_id: &str,
        realization: &EnvironmentRealization,
        cancellation: watch::Receiver<bool>,
    ) -> Result<Verification, HandlerError> {
        self.owner
            .verify(operation_id, realization, cancellation)
            .await
            .map_err(error)
    }
    async fn reconcile(
        &self,
        operation_id: &str,
    ) -> Result<EnvironmentReconciliation, HandlerError> {
        self.owner.reconcile(operation_id).await.map_err(error)
    }
    async fn material_state(
        &self,
        source_id: &str,
        kind: MaterialKind,
        cleanup_id: Option<&str>,
    ) -> Result<MaterialState, String> {
        self.owner.material_state(source_id, kind, cleanup_id).await
    }
    async fn change_material(
        &self,
        source_id: &str,
        kind: MaterialKind,
        cleanup_id: &str,
        action: MaterialAction,
        expected_fingerprint: &str,
    ) -> Result<MaterialChange, HandlerError> {
        self.owner
            .change_material(source_id, kind, cleanup_id, action, expected_fingerprint)
            .await
            .map_err(error)
    }
}
