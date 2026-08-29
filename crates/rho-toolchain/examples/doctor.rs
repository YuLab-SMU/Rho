use std::path::PathBuf;

use rho_toolchain::{DoctorStatus, doctor};

fn main() {
    let Some(project_root) = std::env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("usage: cargo run -p rho-toolchain --example doctor -- PROJECT");
        std::process::exit(2);
    };
    match doctor(&project_root) {
        Ok(report) => {
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
            if report.status != DoctorStatus::Ready {
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
