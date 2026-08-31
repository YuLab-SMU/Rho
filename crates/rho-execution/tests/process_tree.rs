use std::{collections::VecDeque, time::Duration};

use rho_execution::{local::ProcessIdentity, process_tree::*};

struct FakeProbe {
    matches: bool,
    dead: VecDeque<Option<bool>>,
}

impl ProcessIdentityProbe for FakeProbe {
    fn identity_matches(&mut self, _identity: &ProcessIdentity) -> bool {
        self.matches
    }

    fn whole_tree_dead(&mut self, _identity: &ProcessIdentity) -> Option<bool> {
        self.dead.pop_front().unwrap_or(None)
    }
}

#[derive(Default)]
struct FakeSignal {
    calls: usize,
    whole_tree: bool,
}

impl TreeSignalPort for FakeSignal {
    fn terminate_tree(&mut self, _identity: &ProcessIdentity) -> Result<TreeSignalResult, String> {
        self.calls += 1;
        Ok(TreeSignalResult {
            whole_tree_targeted: self.whole_tree,
        })
    }
}

fn identity(pid: u32, nonce: &str) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        executable_sha256:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        launch_nonce: nonce.to_string(),
        started_unix_ms: 100,
    }
}

#[test]
fn process_tree_cancel_distinguishes_requested_signal_and_confirmed_dead_with_latency() {
    let probe = FakeProbe {
        matches: true,
        dead: [Some(false), Some(true)].into(),
    };
    let signal = FakeSignal {
        whole_tree: true,
        ..FakeSignal::default()
    };
    let mut controller = ProcessTreeController::new(probe, signal);
    let observation = controller
        .cancel(&identity(123, "launch_1"), 1000, Duration::from_millis(100))
        .unwrap();
    assert_eq!(observation.state, TreeCancelState::ConfirmedDead);
    assert!(observation.whole_tree_targeted);
    assert!(observation.latency_ms.is_some());
    assert_eq!(controller.state(), TreeCancelState::ConfirmedDead);

    let duplicate = controller
        .cancel(&identity(123, "launch_1"), 1100, Duration::from_millis(100))
        .unwrap();
    assert_eq!(duplicate.state, TreeCancelState::AlreadyTerminal);
}

#[test]
fn process_tree_pid_reuse_or_identity_mismatch_never_signals_unrelated_process() {
    let probe = FakeProbe {
        matches: false,
        dead: VecDeque::new(),
    };
    let signal = FakeSignal {
        whole_tree: true,
        ..FakeSignal::default()
    };
    let mut controller = ProcessTreeController::new(probe, signal);
    assert_eq!(
        controller
            .cancel(
                &identity(123, "old_start_identity"),
                1000,
                Duration::from_millis(10)
            )
            .unwrap_err(),
        ProcessTreeError::IdentityMismatch
    );
    assert_eq!(controller.state(), TreeCancelState::ReconcileRequired);
}

#[test]
fn process_tree_unconfirmed_or_child_escape_is_explicit_reconcile_not_success() {
    let probe = FakeProbe {
        matches: true,
        dead: [None].into(),
    };
    let signal = FakeSignal {
        whole_tree: false,
        ..FakeSignal::default()
    };
    let mut controller = ProcessTreeController::new(probe, signal);
    let observation = controller
        .cancel(
            &identity(123, "launch_escape"),
            1000,
            Duration::from_millis(10),
        )
        .unwrap();
    assert_eq!(observation.state, TreeCancelState::ReconcileRequired);
    assert!(!observation.whole_tree_targeted);
    assert_eq!(
        observation.reason_code,
        "child_escape_guarantee_unavailable"
    );
}

#[test]
fn process_tree_boundary_forbids_pid_only_kill_unrelated_signal_and_unconfirmed_success() {
    let (_, does_not_own) = process_tree_boundary();
    assert!(does_not_own.contains(&"pid_only_kill"));
    assert!(does_not_own.contains(&"unrelated_process_signal"));
    assert!(does_not_own.contains(&"unconfirmed_success"));
    assert!(does_not_own.contains(&"silent_child_escape"));
}

#[cfg(unix)]
#[test]
fn process_tree_os_signal_targets_and_reaps_a_real_child_group() {
    use std::{
        os::unix::process::CommandExt,
        process::{Command, Stdio},
    };

    struct GroupProbe;
    impl ProcessIdentityProbe for GroupProbe {
        fn identity_matches(&mut self, identity: &ProcessIdentity) -> bool {
            std::path::Path::new(&format!("/proc/{}", identity.pid)).exists()
                || std::process::Command::new("/bin/kill")
                    .args(["-0", &identity.pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|status| status.success())
        }

        fn whole_tree_dead(&mut self, identity: &ProcessIdentity) -> Option<bool> {
            let group = format!("-{}", identity.pid);
            let alive = std::process::Command::new("/bin/kill")
                .args(["-0", &group])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success());
            Some(!alive)
        }
    }

    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("sleep 30 & wait")
        .process_group(0)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().unwrap();
    let identity = identity(child.id(), "real_group");
    let reaper = std::thread::spawn(move || child.wait());
    let mut controller = ProcessTreeController::new(GroupProbe, OsTreeSignalPort);
    let observation = controller
        .cancel(&identity, 1000, Duration::from_secs(1))
        .unwrap();
    let _ = reaper.join();
    assert_eq!(observation.state, TreeCancelState::ConfirmedDead);
    assert!(observation.whole_tree_targeted);
}
