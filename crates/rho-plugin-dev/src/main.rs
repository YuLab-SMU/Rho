use std::env;
use std::path::Path;
use std::process::ExitCode;

use rho_plugin_dev::{build_project, check_project, smoke_command, smoke_tool, smoke_viewer};

fn main() -> ExitCode {
    match run(env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("plugin_dev_error: {error}");
            ExitCode::from(1)
        }
    }
}

fn run(arguments: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    match arguments.as_slice() {
        [command, project_root] if command == "build" => {
            let report = build_project(Path::new(project_root))?;
            for plugin in report.check.plugins {
                println!(
                    "build_ok plugin={} digest={} runtime={} contributions={}",
                    plugin.plugin_id, plugin.digest, plugin.runtime_kind, plugin.contribution_count
                );
            }
        }
        [command, project_root] if command == "check" => {
            let report = check_project(Path::new(project_root))?;
            for plugin in report.plugins {
                println!(
                    "check_ok plugin={} version={} digest={} runtime={} contributions={}",
                    plugin.plugin_id,
                    plugin.version,
                    plugin.digest,
                    plugin.runtime_kind,
                    plugin.contribution_count
                );
            }
        }
        [command, project_root, plugin_id, contribution_id] if command == "smoke-command" => {
            let report = smoke_command(Path::new(project_root), plugin_id, contribution_id)?;
            print_smoke(report);
        }
        [command, project_root, plugin_id, contribution_id] if command == "smoke-tool" => {
            let report = smoke_tool(Path::new(project_root), plugin_id, contribution_id)?;
            print_smoke(report);
        }
        [command, project_root, plugin_id, contribution_id] if command == "smoke-viewer" => {
            let report = smoke_viewer(Path::new(project_root), plugin_id, contribution_id)?;
            print_smoke(report);
        }
        _ => {
            return Err(
                "usage: rho-plugin-dev <build|check> <project-root> | rho-plugin-dev <smoke-command|smoke-tool|smoke-viewer> <project-root> <plugin-id> <contribution-id>"
                    .into(),
            );
        }
    }
    Ok(())
}

fn print_smoke(report: rho_plugin_dev::ContributionSmokeReport) {
    println!(
        "smoke_ok plugin={} contribution={} kind={} digest={} abi={} result_contract={}",
        report.plugin_id,
        report.contribution_id,
        report.contribution_kind,
        report.digest,
        report.guest_abi,
        report.result_contract
    );
}
