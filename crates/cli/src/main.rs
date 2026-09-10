use std::path::PathBuf;
use std::sync::Arc;
mod connection;
mod session;

use clap::{Parser, Subcommand};
use rho_contract::{
    CapabilityRef, Invocation, MAIN_WORKSPACE_INSTANCE, OperationId, Precondition, QueryRequest,
};
use rho_host::{HostProfile, NextHost, RUN_R_CAPABILITY_ID, RuntimeConfiguration, SshConfig};
use serde_json::json;

#[derive(Debug, Parser)]
#[command(name = "rho", about = "Rho scientific workspace")]
struct Cli {
    #[arg(long, default_value_os_t = rho_host::default_database())]
    database: PathBuf,
    /// Connect to an existing Workbench using its private launch URL file; no local Host is opened.
    #[arg(long)]
    connect_url_file: Option<PathBuf>,
    /// Explicit test-only runtime; does not run R.
    #[arg(long, conflicts_with = "ark")]
    demo: bool,
    #[arg(long)]
    ark: Option<PathBuf>,
    #[arg(long)]
    r_home: Option<PathBuf>,
    /// Prepared, verified Rho recovery component for this R installation.
    #[arg(long)]
    checkpoint_helper: Option<PathBuf>,
    #[arg(long)]
    rscript: Option<PathBuf>,
    /// Bind a verified Environment realization when starting a new Ark session.
    #[arg(long, requires = "ark")]
    environment: Option<String>,
    #[arg(long)]
    project: Option<PathBuf>,
    /// Launcher-attested JSON manifest of exact existing Skill package roots.
    #[arg(long, conflicts_with = "demo")]
    host_skills: Option<PathBuf>,
    /// An existing OpenSSH host alias. No connection is made while opening Host.
    #[arg(long, requires = "remote_root", conflicts_with = "demo")]
    remote_host: Option<String>,
    #[arg(long, requires = "remote_host")]
    remote_root: Option<String>,
    #[arg(long, requires = "remote_host")]
    slurm_cluster: Option<String>,
    #[command(subcommand)]
    command: Command,
}

impl Cli {
    fn profile(&self) -> Result<HostProfile, String> {
        let remote = self.remote_host.as_ref().map(|host| SshConfig {
            host_alias: host.clone(),
            project_root: self.remote_root.clone().unwrap_or_default(),
            slurm_cluster: self.slurm_cluster.clone(),
        });
        let runtime = if let Some(executable) = &self.ark {
            RuntimeConfiguration::Ark {
                executable: executable.clone(),
                r_home: self
                    .r_home
                    .clone()
                    .ok_or("--r-home is required with --ark")?,
                environment: self.environment.clone(),
                checkpoint_helper_path: self.checkpoint_helper.clone(),
            }
        } else if matches!(self.command, Command::Workbench { .. }) && self.r_home.is_some() {
            RuntimeConfiguration::Ark {
                executable: rho_host::discover_r()
                    .first()
                    .map(|s| PathBuf::from(&s.ark))
                    .unwrap_or_default(),
                r_home: self.r_home.clone().unwrap(),
                environment: None,
                checkpoint_helper_path: self.checkpoint_helper.clone(),
            }
        } else if let Some(rscript) = &self.rscript {
            RuntimeConfiguration::Environment {
                rscript: rscript.clone(),
            }
        } else {
            RuntimeConfiguration::Project
        };
        Ok(HostProfile {
            database: self.database.clone(),
            runtime,
            remote,
            host_skills: self.host_skills.clone(),
        })
    }

    async fn open_host(&self) -> Result<NextHost, String> {
        if self.demo {
            return NextHost::open_demo(&self.database)
                .await
                .map_err(|error| error.to_string());
        }
        self.profile()?
            .open(self.project.as_deref().ok_or("--project is required")?)
            .await
    }
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Keep one Host/R session alive; read and write the typed session protocol over stdio.
    Session,
    /// Serve MCP over stdio using the same Host and capability registry.
    Mcp,
    /// Serve the local browser workbench and MCP using one Host. No external hosting.
    Workbench {
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// Write the private launch URL to a new file instead of stdout.
        #[arg(long)]
        url_file: Option<PathBuf>,
        /// Read app.js and style.css from this build directory without restarting R.
        #[arg(long)]
        dev_assets: Option<PathBuf>,
    },
    Invoke {
        #[arg(long)]
        client_request_id: String,
        /// Fixed logical R instance for --code. A standalone managed Host defaults
        /// to Main; --connect-url-file needs this explicitly. Generic --arguments
        /// carries its own target.
        #[arg(long, requires = "code")]
        workspace_instance: Option<String>,
        #[arg(
            long,
            required_unless_present = "arguments",
            conflicts_with = "arguments"
        )]
        code: Option<String>,
        #[arg(long, conflicts_with = "code")]
        arguments: Option<String>,
        #[arg(long, default_value = RUN_R_CAPABILITY_ID)]
        capability: String,
        #[arg(long, default_value_t = 1)]
        capability_version: u16,
        #[arg(long, default_value = "[]")]
        preconditions: String,
        #[arg(long)]
        expected_session: Option<String>,
    },
    /// Read through a standalone observer without runtime startup, writer leases or recovery.
    Query {
        #[arg(long)]
        capability: String,
        #[arg(long, default_value_t = 1)]
        capability_version: u16,
        #[arg(long, default_value = "{}")]
        arguments: String,
    },
    /// Record an explicitly selected or excluded method through shared Application control.
    BindMethod {
        #[arg(long)]
        expected_version: Option<String>,
        #[arg(long)]
        binding: String,
    },
    /// Send one typed HostRequest through --connect-url-file (including application controls).
    Request {
        #[arg(long)]
        json: String,
    },
    GetOperation {
        operation_id: String,
    },
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "ok": false,
                "error": error.message,
                "diagnostic": error.diagnostic,
            }))
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encoding failure\"}".to_string())
        );
        std::process::exit(1);
    }
}

#[derive(Debug)]
struct CliFailure {
    message: String,
    diagnostic: Option<rho_contract::Diagnostic>,
}
impl From<String> for CliFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            diagnostic: None,
        }
    }
}
impl From<&str> for CliFailure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
impl From<rho_host::OperationError> for CliFailure {
    fn from(error: rho_host::OperationError) -> Self {
        Self {
            message: error.to_string(),
            diagnostic: Some(error.diagnostic()),
        }
    }
}

async fn run() -> Result<(), CliFailure> {
    let cli = Cli::parse();
    let context = NextHost::local_context();
    if let Some(path) = &cli.connect_url_file {
        if cli.demo
            || cli.ark.is_some()
            || cli.r_home.is_some()
            || cli.checkpoint_helper.is_some()
            || cli.rscript.is_some()
            || cli.environment.is_some()
            || cli.remote_host.is_some()
            || cli.remote_root.is_some()
            || cli.slurm_cluster.is_some()
            || cli.host_skills.is_some()
        {
            return Err(rho_host::OperationError::InvalidInput("Connected commands use the existing Host configuration; runtime/source startup flags cannot be combined with --connect-url-file".into()).into());
        }
        let (request,label)=match &cli.command {
            Command::Query {capability,capability_version,arguments}=>(json!({"method":"query_snapshot","params":{"capability":CapabilityRef::new(capability,*capability_version).map_err(|e|e.to_string())?,"arguments":serde_json::from_str::<serde_json::Value>(arguments).map_err(|e|e.to_string())?}}),"observation"),
            Command::Invoke {..}=>(json!({"method":"invoke","params":invocation(&cli.command)?}),"operation"),
            Command::GetOperation {operation_id}=>(json!({"method":"get_operation","params":{"operation_id":OperationId::new(operation_id).map_err(|e|e.to_string())?}}),"operation"),
            Command::BindMethod {expected_version,binding}=>{let binding:rho_contract::ApplicationMethodBinding=serde_json::from_str(binding).map_err(|e|e.to_string())?;(json!({"method":"bind_method","params":{"expected_version":expected_version,"binding":binding}}),"binding")},
            Command::Request {json}=>(serde_json::from_str::<serde_json::Value>(json).map_err(|e|e.to_string())?,"result"),
            _=>return Err(rho_host::OperationError::InvalidInput("--connect-url-file supports query, invoke, get-operation, bind-method and request; it never launches a server or runtime".into()).into()),
        };
        let host = connection::ConnectedHost::open(path, cli.project.as_deref()).await?;
        let result = host.submit(request).await?;
        let mut response = json!({"ok":true,"mode":"connected_host"});
        response[label] = result;
        return print_json(&response).map_err(Into::into);
    }
    if matches!(cli.command, Command::Request { .. }) {
        return Err(rho_host::OperationError::InvalidInput(
            "The request command requires --connect-url-file for an existing Host".into(),
        )
        .into());
    }
    if let Command::Workbench {
        port,
        url_file,
        dev_assets,
    } = &cli.command
    {
        if cli.demo {
            return Err("workbench requires a real project/runtime; --demo is test-only".into());
        }
        if cli.project.is_none() && (cli.environment.is_some() || cli.remote_host.is_some()) {
            return Err(
                "--project is required for an initial environment or remote binding".into(),
            );
        }
        return rho_workbench::serve_with_assets(
            cli.profile()?,
            cli.project.as_deref(),
            *port,
            url_file.as_deref(),
            dev_assets.as_deref(),
        )
        .await
        .map_err(Into::into);
    }
    if matches!(cli.command, Command::Mcp) {
        let host = Arc::new(cli.open_host().await?);
        return rho_mcp::serve(host, tokio::io::stdin(), tokio::io::stdout())
            .await
            .map_err(Into::into);
    }
    if matches!(cli.command, Command::Session) {
        let host = Arc::new(cli.open_host().await?);
        return session::serve(host, tokio::io::stdin(), tokio::io::stdout())
            .await
            .map_err(Into::into);
    }
    if let Command::Query {
        capability,
        capability_version,
        arguments,
    } = &cli.command
    {
        if cli.demo
            || cli.ark.is_some()
            || cli.r_home.is_some()
            || cli.checkpoint_helper.is_some()
            || cli.rscript.is_some()
            || cli.environment.is_some()
            || cli.remote_host.is_some()
            || cli.remote_root.is_some()
            || cli.slurm_cluster.is_some()
            || cli.host_skills.is_some()
        {
            return Err(rho_host::OperationError::InvalidInput("Standalone query does not accept runtime or live-owner startup configuration. Connect to the existing Host session/MCP for R, Environment, remote or application/Skill queries.".into()).into());
        }
        let observer = NextHost::open_query_observer(&cli.database, cli.project.as_deref())?;
        let observation = observer
            .query_snapshot(
                &context,
                QueryRequest {
                    capability: CapabilityRef::new(capability, *capability_version)
                        .map_err(|e| e.to_string())?,
                    arguments: serde_json::from_str(arguments).map_err(|e| e.to_string())?,
                },
            )
            .await?;
        return print_json(
            &json!({"ok":true,"mode":"standalone_observer","observation":observation}),
        )
        .map_err(Into::into);
    }
    let prepared_invocation = if matches!(cli.command, Command::Invoke { .. }) {
        Some(invocation(&cli.command)?)
    } else {
        None
    };
    let active_host = if matches!(
        cli.command,
        Command::Invoke { .. } | Command::BindMethod { .. }
    ) {
        Some(cli.open_host().await?)
    } else {
        None
    };
    let result = match cli.command {
        Command::Session
        | Command::Mcp
        | Command::Workbench { .. }
        | Command::Query { .. }
        | Command::Request { .. } => {
            unreachable!()
        }
        Command::Invoke { .. } => {
            let host = active_host.expect("invoke opens one Host");
            let invocation =
                prepared_invocation.expect("invoke uses its prepared original parameters");
            let record = host.invoke(&context, targeted(&host, invocation)).await?;
            print_json(&json!({
                "ok": true,
                "runtime": if cli.demo { "deterministic_fake" } else if cli.ark.is_some() { "ark" } else if cli.rscript.is_some() { "environment" } else { "project" },
                "operation": record,
            }))
        }
        Command::BindMethod {
            expected_version,
            binding,
        } => {
            let host = active_host.expect("method binding opens one Host");
            let binding = serde_json::from_str(&binding).map_err(|e| e.to_string())?;
            let binding = host
                .dispatch(
                    &context,
                    rho_contract::HostRequest::BindMethod(rho_contract::BindMethodRequest {
                        expected_version,
                        binding,
                    }),
                )
                .await?;
            print_json(&json!({"ok":true,"binding":binding}))
        }
        Command::GetOperation { operation_id } => {
            let host = NextHost::open_read_only(&cli.database)?;
            let operation_id = OperationId::new(operation_id).map_err(|error| error.to_string())?;
            let record = host.get_operation(&context, &operation_id).await?;
            print_json(&json!({
                "ok": true,
                "operation": record,
            }))
        }
    };
    result.map_err(Into::into)
}

fn invocation(command: &Command) -> Result<Invocation, CliFailure> {
    let Command::Invoke {
        client_request_id,
        workspace_instance,
        code,
        arguments,
        capability,
        capability_version,
        preconditions,
        expected_session,
    } = command
    else {
        return Err("Expected invoke arguments".into());
    };
    let mut preconditions: Vec<Precondition> =
        serde_json::from_str(preconditions).map_err(|e| e.to_string())?;
    if let Some(session) = expected_session {
        preconditions.push(Precondition {
            kind: "workspace.session".into(),
            subject: "active".into(),
            expected: json!(session),
        });
    }
    let mut arguments = if let Some(arguments) = arguments {
        serde_json::from_str(arguments).map_err(|e| e.to_string())?
    } else {
        json!({"code":code.as_ref().ok_or("--code or --arguments is required")?})
    };
    if let Some(instance) = workspace_instance {
        arguments["workspace_instance_id"] = json!(instance);
    }
    let invocation = Invocation {
        client_request_id: client_request_id.clone(),
        capability: CapabilityRef::new(capability, *capability_version)
            .map_err(|e| e.to_string())?,
        arguments,
        preconditions,
    };
    invocation.validate().map_err(|e| e.to_string())?;
    Ok(invocation)
}

/// A managed Host routes live R work to an explicit instance. The one-shot invoke
/// names the Host's default instead of making the caller repeat it, and only where
/// the published contract actually requires a target.
fn targeted(host: &NextHost, mut invocation: Invocation) -> Invocation {
    let requires_instance = host
        .capabilities()
        .iter()
        .find(|descriptor| descriptor.capability == invocation.capability)
        .is_some_and(|descriptor| {
            descriptor.input_schema["required"]
                .as_array()
                .is_some_and(|required| {
                    required
                        .iter()
                        .any(|name| name == "workspace_instance_id")
                })
        });
    if requires_instance && invocation.arguments.get("workspace_instance_id").is_none() {
        invocation.arguments["workspace_instance_id"] = json!(MAIN_WORKSPACE_INSTANCE);
    }
    invocation
}

fn print_json(value: &serde_json::Value) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
    );
    Ok(())
}
