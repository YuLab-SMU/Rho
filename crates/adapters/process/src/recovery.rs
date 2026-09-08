use rho_contract::ObservationCompleteness;
use rho_execution::{NativeProcessIdentity, ProcessReconciliation};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    time::{Duration, Instant},
};
use sysinfo::{
    Pid, Process, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, Signal, System, Uid,
    UpdateKind,
};

const MAX_MATCHES: usize = 1024;

fn refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .without_tasks()
        .with_environ(UpdateKind::Always)
        .with_user(UpdateKind::Always)
}
fn alive(process: &Process) -> bool {
    process.exists()
        && !matches!(
            process.status(),
            ProcessStatus::Zombie | ProcessStatus::Dead
        )
}
fn identity(process: &Process) -> NativeProcessIdentity {
    NativeProcessIdentity {
        pid: process.pid().as_u32(),
        started_at_seconds: process.start_time(),
    }
}
fn tagged(process: &Process, marker: &OsStr, user: &Uid) -> bool {
    process.pid().as_u32() != std::process::id()
        && alive(process)
        && process.user_id() == Some(user)
        && process.environ().iter().any(|entry| entry == marker)
}
fn snapshot(marker: &OsStr, user: &Uid) -> Result<Vec<NativeProcessIdentity>, String> {
    snapshot_with_owner(marker, user, None)
}
fn snapshot_with_owner(
    marker: &OsStr,
    user: &Uid,
    owner: Option<&OsStr>,
) -> Result<Vec<NativeProcessIdentity>, String> {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_user(UpdateKind::Always),
    );
    if system.process(Pid::from_u32(std::process::id())).is_none() {
        return Err("native process enumeration is unavailable".into());
    }
    let owned = system
        .processes()
        .values()
        .filter(|process| process.user_id() == Some(user))
        .map(Process::pid)
        .collect::<Vec<_>>();
    if owned.len() > 16384 {
        return Err("same-user process inspection exceeds its bound".into());
    }
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&owned), true, refresh_kind());
    if let Some(owner) = owner {
        if system.processes().values().any(|process| {
            tagged(process, marker, user) && !process.environ().iter().any(|entry| entry == owner)
        }) {
            return Err("native process marker belongs to a different Operation".into());
        }
    }
    let mut matches = system
        .processes()
        .values()
        .filter(|process| tagged(process, marker, user))
        .map(identity)
        .collect::<Vec<_>>();
    if matches.len() > MAX_MATCHES {
        return Err("tagged process count exceeds the reconciliation bound".into());
    }
    matches.sort_by_key(|process| process.pid);
    Ok(matches)
}

/// Bounded OS observation only: no helper process, signal, wait or recovery.
/// Matches the native tree marker and original Operation tag for the same user.
pub fn inspect_process_marker(
    marker: &str,
    operation_id: &str,
) -> Result<Vec<NativeProcessIdentity>, String> {
    if marker.is_empty()
        || marker.len() > 200
        || !marker
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err("invalid native process marker".into());
    }
    rho_contract::OperationId::new(operation_id).map_err(|error| error.to_string())?;
    if !sysinfo::IS_SUPPORTED_SYSTEM {
        return Err("native process inspection is unsupported on this platform".into());
    }
    let mut own = System::new();
    let self_pid = Pid::from_u32(std::process::id());
    own.refresh_processes_specifics(ProcessesToUpdate::Some(&[self_pid]), true, refresh_kind());
    let process = own
        .process(self_pid)
        .ok_or("native self inspection is unavailable")?;
    if process.environ().is_empty() {
        return Err("native process environment inspection is unavailable".into());
    }
    let user = process
        .user_id()
        .ok_or("native process owner is unavailable")?;
    snapshot_with_owner(
        OsStr::new(&format!("{marker}=YES")),
        user,
        Some(OsStr::new(&format!("RHO_OPERATION_ID={operation_id}"))),
    )
}

/// Query fresh native state. No PID saved in a result or journal authorizes a signal.
/// Environment values are inspected transiently and are never included in output.
pub(super) fn reconcile_tagged(operation_id: &str) -> Result<ProcessReconciliation, String> {
    if !sysinfo::IS_SUPPORTED_SYSTEM {
        return Err("native process inspection is unsupported on this platform".into());
    }
    let mut own = System::new();
    let self_pid = Pid::from_u32(std::process::id());
    own.refresh_processes_specifics(ProcessesToUpdate::Some(&[self_pid]), true, refresh_kind());
    let process = own
        .process(self_pid)
        .ok_or("native self inspection is unavailable")?;
    if process.environ().is_empty() {
        return Err("native process environment inspection is unavailable".into());
    }
    let user = process
        .user_id()
        .ok_or("native process owner is unavailable")?
        .clone();
    let marker = format!("RHO_OPERATION_ID={operation_id}");
    let marker = OsStr::new(&marker);
    let mut observed = BTreeMap::new();
    let mut signalled = BTreeMap::new();
    let started = Instant::now();
    let mut notices = Vec::new();
    let remaining = loop {
        let found = snapshot(marker, &user)?;
        if found.is_empty() || started.elapsed() >= Duration::from_secs(5) {
            break found;
        }
        for expected in found {
            if started.elapsed() >= Duration::from_secs(5) {
                break;
            }
            observed.insert(
                (expected.pid, expected.started_at_seconds),
                expected.clone(),
            );
            if observed.len() > MAX_MATCHES {
                return Err("process churn exceeds the reconciliation bound".into());
            }
            // Recreate the view immediately before signalling: sysinfo's kill
            // takes a PID, and a cached Process alone is not an ownership handle.
            let mut current = System::new();
            current.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[Pid::from_u32(expected.pid)]),
                true,
                refresh_kind(),
            );
            let Some(process) = current.process(Pid::from_u32(expected.pid)) else {
                continue;
            };
            if !tagged(process, marker, &user) || identity(process) != expected {
                continue;
            }
            if process.kill_with(Signal::Kill) == Some(true) {
                signalled.insert((expected.pid, expected.started_at_seconds), expected);
            } else if notices.len() < 8 {
                notices.push(format!(
                    "signal was not accepted for freshly matched PID {}",
                    expected.pid
                ));
            }
        }
        // Bounded native-state observation, not an unbounded Process::wait().
        std::thread::sleep(Duration::from_millis(25));
    };
    notices.push("Scope is visible same-user processes retaining the Operation tag; this is not containment of unobservable or deliberately escaped processes, nor proof of the original operation outcome.".into());
    Ok(ProcessReconciliation {
        source_operation_id: operation_id.into(),
        observed: observed.into_values().collect(),
        signalled: signalled.into_values().collect(),
        no_matching_processes_observed: remaining.is_empty(),
        remaining,
        completeness: ObservationCompleteness::Partial,
        notices,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn marker_inspection_keeps_native_child_alive_and_rejects_wrong_operation() {
        let marker = format!("PSreadonlyfixture{}_1700000000", std::process::id());
        let mut child = ChildGuard(
            Command::new("sleep")
                .arg("30")
                .env(&marker, "YES")
                .env("RHO_OPERATION_ID", "op_native_read_fixture")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let found = inspect_process_marker(&marker, "op_native_read_fixture").unwrap();
        assert!(
            found
                .iter()
                .any(|identity| identity.pid == child.0.id() && identity.started_at_seconds > 0)
        );
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "a read must not signal the process"
        );
        assert!(
            inspect_process_marker(&marker, "op_wrong_owner")
                .unwrap_err()
                .contains("different Operation")
        );
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "an identity mismatch must not signal the process"
        );
    }
}
