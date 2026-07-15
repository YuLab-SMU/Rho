# Rho patches to Jet

Upstream revision: `52ae131dd168fe2e104d306cc4bf5bbeae749200`.

- Replace an unconditional Unix `libc::kill(pid, 0)` startup-error probe with
  `tokio::process::Child::try_wait()`. The original expression does not compile
  on Windows GNU, while `try_wait()` preserves the intended cross-platform
  process-liveness check.
- Prefix three Unix-only PID bindings with `_` so Windows builds remain
  warning-free. The variables are still used unchanged on Unix.
