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
    process.exists() && status_may_be_alive(process.status())
}
fn status_may_be_alive(status: ProcessStatus) -> bool {
    // sysinfo maps Darwin's TH_STATE_UNINTERRUPTIBLE (a live waiting thread)
    // to Dead. That thread-state label cannot establish process termination.
    #[cfg(target_os = "macos")]
    {
        status != ProcessStatus::Zombie
    }
    #[cfg(not(target_os = "macos"))]
    {
        !matches!(status, ProcessStatus::Zombie | ProcessStatus::Dead)
    }
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
    snapshot_with_owner(marker, user, None, None, None)
}
fn snapshot_with_owner(
    marker: &OsStr,
    user: &Uid,
    owner: Option<&OsStr>,
    not_before_seconds: Option<u64>,
    original_session_id: Option<u32>,
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
        .filter(|process| {
            process.user_id() == Some(user)
                && not_before_seconds
                    .is_none_or(|since| process.start_time() == 0 || process.start_time() >= since)
        })
        .map(Process::pid)
        .collect::<Vec<_>>();
    if owned.len() > 16384 {
        return Err("same-user process inspection exceeds its bound".into());
    }
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&owned), true, refresh_kind());
    let uncertain = system
        .processes()
        .values()
        .filter(|process| {
            process.user_id() == Some(user)
                && alive(process)
                && not_before_seconds
                    .is_none_or(|since| process.start_time() == 0 || process.start_time() >= since)
                && (process.start_time() == 0 || process.environ().is_empty())
        })
        .collect::<Vec<_>>();
    if let Some(owner) = owner
        && system.processes().values().any(|process| {
            tagged(process, marker, user) && !process.environ().iter().any(|entry| entry == owner)
        })
    {
        return Err("native process marker belongs to a different Operation".into());
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
    if matches
        .iter()
        .any(|process| process.started_at_seconds == 0)
    {
        return Err("native matched process lifetime identity is unavailable".into());
    }
    // An observable positive match is enough to retain material. An empty list
    // is not negative evidence while another same-user process lacks a native
    // environment/lifetime observation (notably protected binaries on macOS).
    if let Some(owner) = owner.filter(|_| matches.is_empty()) {
        if uncertain.len() > 128 {
            return Err("native uncertain process follow-up exceeds its 128-identity bound".into());
        }
        let mut unavailable = false;
        for previous in uncertain {
            let fresh = fresh_identity(previous.pid());
            let Some(process) = fresh.process(previous.pid()) else {
                // A missing sysinfo row is not itself proof of process death.
                // On Darwin its getsid wrapper preserves ESRCH for a vanished PID.
                if !native_pid_is_gone(previous) {
                    unavailable = true;
                }
                continue;
            };
            if !alive(process)
                || process.user_id().is_some_and(|uid| uid != user)
                || not_before_seconds
                    .is_some_and(|since| process.start_time() > 0 && process.start_time() < since)
            {
                continue;
            }
            if tagged(process, marker, user) {
                if !process.environ().iter().any(|entry| entry == owner) {
                    return Err("native process marker belongs to a different Operation".into());
                }
                if process.start_time() == 0 {
                    unavailable = true;
                } else {
                    matches.push(identity(process));
                }
                continue;
            }
            if process.user_id() == Some(user)
                && process.start_time() > 0
                && !process.environ().is_empty()
            {
                continue;
            }
            if !outside_original_helper_session(process, original_session_id, marker)? {
                unavailable = true;
            }
        }
        if matches.is_empty() && unavailable {
            return Err("native process marker absence is unavailable: a same-user process has no environment or lifetime evidence".into());
        }
    }
    matches.sort_by_key(|process| process.pid);
    Ok(matches)
}

fn fresh_identity(pid: Pid) -> System {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, refresh_kind());
    system
}

#[cfg(target_os = "macos")]
fn native_pid_is_gone(process: &Process) -> bool {
    // sysinfo 0.39's Darwin session_id is a direct getsid(pid) wrapper. Observe
    // errno immediately: EPERM/other failures remain unknown, ESRCH proves gone.
    process.session_id().is_none()
        && std::io::Error::last_os_error().raw_os_error() == Some(nix::errno::Errno::ESRCH as i32)
}
#[cfg(not(target_os = "macos"))]
fn native_pid_is_gone(_: &Process) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn outside_original_helper_session(
    process: &Process,
    original: Option<u32>,
    marker: &OsStr,
) -> Result<bool, String> {
    if !original.is_some_and(|id| id > 1) || process.session_id() != Some(Pid::from_u32(1)) {
        return Ok(false);
    }
    // fork/exec preserve the original session; setsid creates the caller's own
    // PID as a new session. Neither can join the already-existing init session.
    // This scopes evidence to the owned helper family, not arbitrary work
    // delegated to external service managers and not rollback of side effects.
    let verified = fresh_identity(process.pid());
    let Some(after) = verified.process(process.pid()) else {
        return Ok(false);
    };
    if after.environ().iter().any(|entry| entry == marker) {
        return Err(
            "native original-session proof conflicts with an observed process marker".into(),
        );
    }
    Ok(identity(after) == identity(process)
        && after.start_time() > 0
        && after.user_id() == process.user_id()
        && after.session_id() == Some(Pid::from_u32(1)))
}

#[cfg(not(target_os = "macos"))]
fn outside_original_helper_session(_: &Process, _: Option<u32>, _: &OsStr) -> Result<bool, String> {
    Ok(false)
}

/// Native session inherited by managed helpers. Record at launch; a later
/// observer's session cannot substitute for this original process-family fact.
pub fn current_process_session_id() -> Option<u32> {
    let pid = Pid::from_u32(std::process::id());
    fresh_identity(pid)
        .process(pid)?
        .session_id()
        .map(|session| session.as_u32())
        .filter(|id| *id > 0)
}

/// Bounded OS observation only: no helper process, signal, wait or recovery.
/// Matches the native tree marker and original Operation tag for the same user.
/// The ps marker suffix is its creation time in whole Unix seconds; older
/// processes cannot be its inheriting descendants and are outside this read.
pub fn inspect_process_marker(
    marker: &str,
    operation_id: &str,
) -> Result<Vec<NativeProcessIdentity>, String> {
    inspect_process_marker_in_session(marker, operation_id, None)
}

/// Inspect an owned native helper family using its original recorded session.
/// Missing session evidence remains conservative; it is never inferred from the
/// current observer, an executable name, or an orphan's parent PID.
pub fn inspect_process_marker_in_session(
    marker: &str,
    operation_id: &str,
    original_session_id: Option<u32>,
) -> Result<Vec<NativeProcessIdentity>, String> {
    if marker.is_empty()
        || marker.len() > 200
        || !marker
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err("invalid native process marker".into());
    }
    let (random, timestamp) = marker
        .rsplit_once('_')
        .ok_or("invalid native process marker timestamp")?;
    if !random.starts_with("PS")
        || random.len() <= 2
        || !random
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("invalid native process marker identity".into());
    }
    let not_before_seconds = timestamp
        .parse::<u64>()
        .map_err(|_| "invalid native process marker timestamp")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    if not_before_seconds > now {
        return Err("native process marker timestamp is in the future".into());
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
        Some(not_before_seconds),
        original_session_id,
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
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, Command, Stdio};

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn await_ready(child: &mut ChildGuard) {
        let stdout = child.0.stdout.take().unwrap();
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut ready = String::new();
            let mut reader = BufReader::new(stdout);
            let result = (|| -> std::io::Result<bool> {
                for _ in 0..16 {
                    ready.clear();
                    if reader.read_line(&mut ready)? == 0 {
                        return Ok(false);
                    }
                    if ready.contains("RHO_NATIVE_MARKER_READY") {
                        return Ok(true);
                    }
                }
                Ok(false)
            })();
            let _ = send.send(result);
            // Keep the child's stdout pipe open until its test harness exits.
            // Dropping it at readiness would turn the final test summary into
            // a broken-pipe failure unrelated to native process observation.
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        assert!(
            receive
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap(),
            "the controlled child must reach its own pipe handshake before native inspection"
        );
    }

    #[test]
    fn marker_inspection_keeps_native_child_alive_and_rejects_wrong_operation() {
        let since = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let marker = format!("PSreadonlyfixture{}_{since}", std::process::id());
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "recovery::tests::native_marker_child_fixture",
                    "--nocapture",
                ])
                .env_clear()
                .env(&marker, "YES")
                .env("RHO_OPERATION_ID", "op_native_read_fixture")
                .env("RHO_TEST_MARKER", &marker)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        await_ready(&mut child);
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
        let observed_with_scope =
            inspect_process_marker_in_session(&marker, "op_native_read_fixture", Some(1)).unwrap();
        assert!(
            observed_with_scope
                .iter()
                .any(|identity| identity.pid == child.0.id()),
            "recorded session hints must never discard positive marker/owner evidence"
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
        child
            .0
            .stdin
            .take()
            .unwrap()
            .write_all(b"finish\n")
            .unwrap();
        assert!(child.0.wait().unwrap().success());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn hidden_native_environment_is_unavailable_not_a_false_empty_match() {
        let since = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let marker = format!("PSprotectedfixture{}_{since}", std::process::id());
        let script = format!(
            "test \"$RHO_OPERATION_ID\" = op_native_read_fixture || exit 3; test \"${marker}\" = YES || exit 4; printf 'RHO_NATIVE_MARKER_READY\\n'; read reply; test \"$reply\" = finish"
        );
        let mut child = ChildGuard(
            Command::new("/bin/sh")
                .args(["-c", &script])
                .env_clear()
                .env(&marker, "YES")
                .env("RHO_OPERATION_ID", "op_native_read_fixture")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        await_ready(&mut child);
        let mut native = System::new();
        native.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[Pid::from_u32(child.0.id())]),
            true,
            refresh_kind(),
        );
        let process = native.process(Pid::from_u32(child.0.id())).unwrap();
        let observed = inspect_process_marker(&marker, "op_native_read_fixture");
        if process.environ().is_empty() {
            assert!(
                observed
                    .unwrap_err()
                    .contains("marker absence is unavailable")
            );
            for original in [None, Some(1), current_process_session_id()] {
                assert!(
                    inspect_process_marker_in_session(&marker, "op_native_read_fixture", original)
                        .unwrap_err()
                        .contains("marker absence is unavailable"),
                    "a hidden child in the original non-init family remains unknown"
                );
            }
        } else {
            // Older macOS releases may expose this Apple binary's environment;
            // positive native evidence must then match the live child exactly.
            assert!(
                observed
                    .unwrap()
                    .iter()
                    .any(|identity| identity.pid == child.0.id())
            );
        }
        assert!(child.0.try_wait().unwrap().is_none());
        child
            .0
            .stdin
            .take()
            .unwrap()
            .write_all(b"finish\n")
            .unwrap();
        assert!(child.0.wait().unwrap().success());
    }

    /// Spawned explicitly by the parent regression. Ordinary test discovery does
    /// not start a process; the parent verifies this fixture's native identity.
    #[test]
    fn native_marker_child_fixture() {
        let Ok(marker) = std::env::var("RHO_TEST_MARKER") else {
            return;
        };
        assert_eq!(std::env::var(&marker).as_deref(), Ok("YES"));
        assert_eq!(
            std::env::var("RHO_OPERATION_ID").as_deref(),
            Ok("op_native_read_fixture")
        );
        println!("RHO_NATIVE_MARKER_READY");
        let mut reply = String::new();
        std::io::stdin().read_line(&mut reply).unwrap();
        assert_eq!(reply, "finish\n");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn darwin_uninterruptible_thread_label_does_not_prove_process_death() {
        assert!(status_may_be_alive(ProcessStatus::Dead));
        assert!(!status_may_be_alive(ProcessStatus::Zombie));
    }
}
