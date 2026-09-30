use std::path::PathBuf;
use std::sync::Arc;
mod connection;
mod plugins;
mod session;

use clap::{Parser, Subcommand};
use rho_contract::{
    CapabilityRef, Invocation, OperationId, Precondition, QueryRequest,
};
use rho_host::NextHost;
use serde_json::json;

#[derive(Debug, Parser)]
#[command(name = "rho", about = "Rho scientific workspace")]
struct Cli {
    #[arg(long, default_value_os_t = rho_host::default_database())]
    database: PathBuf,
    /// Connect to an existing Workbench using its private launch URL file; no local Host is opened.
    #[arg(long)]
    connect_url_file: Option<PathBuf>,
    /// Select an existing disposable test project on the connected Host.
    #[arg(long, requires = "connect_url_file")]
    test_project: Option<String>,
    /// Explicitly select the generic plugin Host (also the default).
    #[arg(long, conflicts_with = "connect_url_file")]
    plugins_only: bool,
    /// Materialize and open the bundled example project in Workbench.
    #[arg(long, conflicts_with_all = ["project", "connect_url_file"])]
    demo_project: bool,
    #[arg(long)]
    project: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

impl Cli {
    async fn open_host(&self) -> Result<NextHost, String> {
        NextHost::open_plugin_workspace(
            &self.database,
            self.project.as_deref().ok_or("--project is required")?,
        )
        .await
        .map_err(|error| error.to_string())
    }

}

#[derive(Debug, Subcommand)]
enum Command {
    /// Recover and develop plugin packages without starting a scientific Host.
    Plugins {
        #[arg(long)]
        store: Option<PathBuf>,
        #[command(subcommand)]
        command: plugins::PluginCommand,
    },
    /// Keep one generic plugin Host alive; read and write the typed session protocol over stdio.
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
        /// Exact arguments from the selected capability's published contract.
        #[arg(long)]
        arguments: String,
        #[arg(long)]
        capability: String,
        #[arg(long, default_value_t = 1)]
        capability_version: u16,
        #[arg(long, default_value = "[]")]
        preconditions: String,
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
    /// Send one typed HostRequest through --connect-url-file.
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
    if cli.demo_project && !matches!(cli.command, Command::Workbench { .. }) {
        return Err("--demo-project applies only to workbench".into());
    }
    if let Command::Plugins { store, command } = &cli.command {
        if cli.plugins_only {
            return Err("Plugin repository commands need no Host; omit --plugins-only".into());
        }
        if cli.connect_url_file.is_some() {
            return Err("Plugin recovery commands address a local --store; they do not use --connect-url-file".into());
        }
        let repository = store.clone().unwrap_or_else(|| rho_plugins::repository_path(&cli.database));
        let result = plugins::run(&repository, command).map_err(|e| e.to_string())?;
        return print_json(&json!({"ok":true,"mode":"plugin_repository","result":result}))
            .map_err(Into::into);
    }
    let context = NextHost::local_context();
    if let Some(path) = &cli.connect_url_file {
        let (request,label)=match &cli.command {
            Command::Query {capability,capability_version,arguments}=>(json!({"method":"query_snapshot","params":{"capability":CapabilityRef::new(capability,*capability_version).map_err(|e|e.to_string())?,"arguments":serde_json::from_str::<serde_json::Value>(arguments).map_err(|e|e.to_string())?}}),"observation"),
            Command::Invoke {..}=>(json!({"method":"invoke","params":invocation(&cli.command)?}),"operation"),
            Command::GetOperation {operation_id}=>(json!({"method":"get_operation","params":{"operation_id":OperationId::new(operation_id).map_err(|e|e.to_string())?}}),"operation"),
            Command::Request {json}=>(serde_json::from_str::<serde_json::Value>(json).map_err(|e|e.to_string())?,"result"),
            _=>return Err(rho_host::OperationError::InvalidInput("--connect-url-file supports query, invoke, get-operation and request; it never launches a server or runtime".into()).into()),
        };
        let test_project = cli.test_project.as_deref().map(rho_plugin_protocol::TestProjectId::new)
            .transpose().map_err(|error|rho_host::OperationError::InvalidInput(error.to_string()))?;
        let host = connection::ConnectedHost::open(path, cli.project.as_deref(), test_project).await?;
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
        let demo_project = if cli.demo_project {
            Some(rho_workbench::materialize_demo_project()?)
        } else {
            None
        };
        let project = demo_project.as_deref().or(cli.project.as_deref());
        return rho_workbench::serve_with_assets(
            cli.database.clone(),
            project,
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
        Command::Invoke { .. }
    ) {
        Some(cli.open_host().await?)
    } else {
        None
    };
    let result = match cli.command {
        Command::Session
        | Command::Plugins { .. }
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
            let record = host.invoke(&context, invocation).await?;
            print_json(&json!({
                "ok": true,
                "runtime": "plugins",
                "operation": record,
            }))
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
        arguments,
        capability,
        capability_version,
        preconditions,
    } = command
    else {
        return Err("Expected invoke arguments".into());
    };
    let preconditions: Vec<Precondition> =
        serde_json::from_str(preconditions).map_err(|e| e.to_string())?;
    let arguments = serde_json::from_str(arguments).map_err(|e| e.to_string())?;
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

fn print_json(value: &serde_json::Value) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
    );
    Ok(())
}

#[cfg(test)]
mod plugin_workspace_arguments {
    use super::*;
    #[test]
    fn generic_host_is_default_and_fixed_runtime_flags_are_rejected() {
        for command in ["session", "mcp", "workbench"] {
            assert!(Cli::try_parse_from(["rho", "--project", "/test", command]).is_ok());
            assert!(Cli::try_parse_from(["rho", "--plugins-only", command]).is_ok());
            for flag in ["--demo", "--ark", "--r-home", "--rscript", "--environment",
                "--checkpoint-helper", "--host-skills", "--remote-host", "--remote-root",
                "--slurm-cluster", "--fixed-workspace"] {
                assert!(Cli::try_parse_from(["rho", flag, command]).is_err(), "{flag}");
            }
        }
        assert!(Cli::try_parse_from(["rho", "--demo-project", "workbench"]).is_ok());
    }
    #[test]
    fn invocation_preserves_exact_arguments_and_preconditions() {
        let args = r#"{"binding":{"instance":"explicit"},"arguments":{"code":"用户内容"}}"#;
        let pre = r#"[{"kind":"fixture.identity","subject":"exact","expected":"v2"}]"#;
        let cli = Cli::try_parse_from(["rho", "invoke", "--client-request-id", "one",
            "--capability", "fixture.run", "--capability-version", "2", "--arguments", args,
            "--preconditions", pre]).unwrap();
        let request = invocation(&cli.command).unwrap();
        assert_eq!(request.arguments, serde_json::from_str::<serde_json::Value>(args).unwrap());
        assert_eq!(request.capability.version, 2);
        assert_eq!(request.preconditions[0].expected, "v2");
        assert!(Cli::try_parse_from(["rho", "invoke", "--client-request-id", "one", "--code", "1"]).is_err());
        assert!(Cli::try_parse_from(["rho", "invoke", "--client-request-id", "one", "--arguments", "{}"]).is_err());
    }
    #[tokio::test]
    async fn plugin_session_without_project_cannot_open_an_owner() {
        let cli = Cli::try_parse_from(["rho", "session"]).unwrap();
        assert!(matches!(cli.open_host().await, Err(message) if message == "--project is required"));
    }
}
