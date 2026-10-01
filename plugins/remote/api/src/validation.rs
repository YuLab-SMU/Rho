use crate::{RemoteTarget, SlurmSourceArguments, SlurmSubmitArguments};
use rho_plugin_protocol::OperationId;
use rho_process_api::RunLocalArguments;

pub fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

impl RemoteTarget {
    pub fn validate(&self) -> Result<(), String> {
        let root = &self.project_root;
        if !safe_name(&self.host_alias)
            || self.host_alias.starts_with('-')
            || !root.starts_with('/')
            || root.ends_with('/')
            || root.trim() != root
            || root.len() > 4096
            || root.chars().any(char::is_control)
            || root.contains('|')
            || root.split('/').any(|part| part == "." || part == "..")
            || root.contains("//")
            || self
                .slurm_cluster
                .as_ref()
                .is_some_and(|cluster| !safe_name(cluster))
        {
            return Err("SSH needs a safe configured host alias, canonical absolute remote root and optional cluster name".into());
        }
        Ok(())
    }
}

pub fn validate_run_arguments(args: &RunLocalArguments) -> Result<(), String> {
    args.validate()?;
    if args.program.starts_with('-') {
        return Err("remote program cannot start with '-' (use an explicit path)".into());
    }
    Ok(())
}

impl SlurmSubmitArguments {
    pub fn validate(&self) -> Result<(), String> {
        if self.body.trim().is_empty()
            || self.body.len() > 128 * 1024
            || self.body.contains('\0')
            || !(1..=512).contains(&self.cpus)
            || !(1..=1_048_576).contains(&self.memory_mb)
            || !(1..=10080).contains(&self.time_minutes)
            || self.gpus > 64
            || [&self.partition, &self.account]
                .into_iter()
                .flatten()
                .any(|name| !safe_name(name))
        {
            return Err("Slurm request exceeds its schema bounds".into());
        }
        Ok(())
    }
}

impl SlurmSourceArguments {
    pub fn source_id(&self) -> Result<OperationId, String> {
        OperationId::new(&self.submission_operation_id).map_err(|error| error.to_string())
    }
}

pub fn terminal_state(state: &str) -> bool {
    matches!(
        state.split([' ', '+']).next().unwrap_or(state),
        "BOOT_FAIL"
            | "CANCELLED"
            | "COMPLETED"
            | "DEADLINE"
            | "FAILED"
            | "NODE_FAIL"
            | "OUT_OF_MEMORY"
            | "PREEMPTED"
            | "REVOKED"
            | "TIMEOUT"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn targets_require_native_canonical_names_and_preserve_literal_paths() {
        let mut target = RemoteTarget {
            host_alias: "fixture".into(),
            project_root: "/scratch/a ' $(literal)".into(),
            slurm_cluster: Some("cluster_a".into()),
        };
        assert!(target.validate().is_ok());
        for root in [
            "/", "relative", "/a/", "/a/../b", "/a/./b", "/a//b", "/a|b", "/a\nb",
        ] {
            target.project_root = root.into();
            assert!(target.validate().is_err(), "{root}");
        }
        target.project_root = "/scratch/project".into();
        target.host_alias = "-option".into();
        assert!(target.validate().is_err());
        assert!(
            serde_json::from_value::<RemoteTarget>(
                json!({"host_alias":"fixture","project_root":"/a","extra":true})
            )
            .is_err()
        );
    }

    #[test]
    fn requests_validate_before_native_effects() {
        let mut run: RunLocalArguments =
            serde_json::from_value(json!({"program":"printf","args":["a ' $(literal)"]})).unwrap();
        assert!(validate_run_arguments(&run).is_ok());
        run.program = "-option".into();
        assert!(validate_run_arguments(&run).is_err());
        let mut submit: SlurmSubmitArguments =
            serde_json::from_value(json!({"body":"printf hello"})).unwrap();
        assert!(submit.validate().is_ok());
        assert_eq!(
            (submit.cpus, submit.memory_mb, submit.time_minutes),
            (1, 1024, 10)
        );
        submit.cpus = 0;
        assert!(submit.validate().is_err());
        submit.cpus = 1;
        submit.partition = Some("name; echo unsafe".into());
        assert!(submit.validate().is_err());
        assert!(
            serde_json::from_value::<SlurmSubmitArguments>(json!({"body":"true","array":"1-100"}))
                .is_err()
        );
        assert!(
            SlurmSourceArguments {
                submission_operation_id: "".into()
            }
            .source_id()
            .is_err()
        );
        assert!(terminal_state("CANCELLED by 42"));
        assert!(!terminal_state("RUNNING"));
    }
}
