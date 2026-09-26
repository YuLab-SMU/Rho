//! Native local process ownership. Callers provide an admitted original operation;
//! this library has no Host, journal, model or independent result database.
#![forbid(unsafe_code)]
pub mod recovery;
use rho_plugin_protocol::OperationId;
use rho_process_api::{ProcessReport, RunLocalArguments};
use rho_process_engine::{ProcessOptions, run_command};
use std::{
    io,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{process::Command, sync::watch};

pub struct LocalProcessOwner {
    root: PathBuf,
    identity: String,
}
impl LocalProcessOwner {
    pub fn new(root: impl AsRef<Path>) -> io::Result<Self> {
        let root = root.as_ref().canonicalize()?;
        if !root.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "process root must be a directory",
            ));
        }
        let identity = root
            .to_str()
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "process root must be UTF-8")
            })?
            .into();
        Ok(Self { root, identity })
    }
    pub fn root(&self) -> &str {
        &self.identity
    }
    pub fn check_root(&self) -> io::Result<()> {
        if self.root.canonicalize()? != self.root {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "process project root changed",
            ));
        }
        Ok(())
    }
    pub async fn run(
        &self,
        operation: &OperationId,
        args: &RunLocalArguments,
        cancellation: watch::Receiver<bool>,
    ) -> io::Result<ProcessReport> {
        self.check_root()?;
        args.validate()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        let mut command = Command::new(&args.program);
        command
            .args(&args.args)
            .current_dir(&self.root)
            .env("RHO_OPERATION_ID", operation.as_str());
        for (name, _) in std::env::vars_os() {
            let key = name.to_string_lossy().to_ascii_uppercase();
            if key.contains("TOKEN")
                || key.contains("SECRET")
                || key.contains("PASSWORD")
                || key.ends_with("KEY")
            {
                command.env_remove(name);
            }
        }
        run_command(
            command,
            ProcessOptions {
                timeout: Duration::from_millis(args.timeout_ms),
                output_limit_bytes: args.output_limit_bytes,
                stdin: args.stdin.as_ref().map(|input| input.as_bytes().to_vec()),
            },
            cancellation,
        )
        .await
    }
}
