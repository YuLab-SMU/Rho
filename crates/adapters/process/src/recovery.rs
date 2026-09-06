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
