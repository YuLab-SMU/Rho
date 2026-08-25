//! Admission boundary for the additive `rho:plugin@1` Component ABI.
//!
//! Admission compiles an exact Component binary with a fresh Engine and rejects
//! every component import. It deliberately creates no Store and executes no
//! guest code; lifecycle dispatch is a separate behavioral boundary.

use std::panic::{AssertUnwindSafe, catch_unwind};

use wasmtime::component::Component;

use crate::{HostProtocolError, HostProtocolErrorCode, PackageDigest, wasm_host::build_engine};

pub const COMPONENT_ABI_V1: u64 = 1;
pub const MAX_WASM_COMPONENT_BYTES: usize = crate::MAX_WASM_MODULE_BYTES;

/// Bindings generated from the repository-owned `rho:plugin@1.0.0` world.
/// WIT owns only the guest/host value contract and grants no host imports.
pub mod bindings {
    wasmtime::component::bindgen!({
        path: "wit",
        world: "plugin",
    });
}

/// A compiled, zero-import Component that has passed the pre-execution
/// admission boundary. Fields remain private until lifecycle execution is
/// introduced so callers cannot bypass the future host state machine.
pub struct AdmittedComponentPlugin {
    _component: Component,
    _engine: wasmtime::Engine,
    digest: PackageDigest,
}

impl std::fmt::Debug for AdmittedComponentPlugin {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AdmittedComponentPlugin")
            .field("digest", &self.digest)
            .finish_non_exhaustive()
    }
}

impl AdmittedComponentPlugin {
    pub fn from_bytes(component_bytes: &[u8]) -> Result<Self, HostProtocolError> {
        if component_bytes.len() > MAX_WASM_COMPONENT_BYTES {
            return Err(protocol_error(HostProtocolErrorCode::ModuleTooLarge));
        }

        let engine = build_engine()?;
        let component = catch_unwind(AssertUnwindSafe(|| {
            Component::from_binary(&engine, component_bytes)
        }))
        .map_err(|_| protocol_error(HostProtocolErrorCode::InvalidModule))?
        .map_err(|_| protocol_error(HostProtocolErrorCode::InvalidModule))?;

        if component.component_type().imports(&engine).next().is_some() {
            return Err(protocol_error(HostProtocolErrorCode::ForbiddenImport));
        }

        let digest = PackageDigest::from_inventory(&[(
            b"guest-v1.component.wasm".as_slice(),
            component_bytes,
        )]);
        Ok(Self {
            _component: component,
            _engine: engine,
            digest,
        })
    }

    pub fn digest(&self) -> &PackageDigest {
        &self.digest
    }
}

fn protocol_error(code: HostProtocolErrorCode) -> HostProtocolError {
    HostProtocolError {
        code,
        message: None,
    }
}
