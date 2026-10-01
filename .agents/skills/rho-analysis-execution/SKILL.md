---
name: rho-analysis-execution
description: Prepare and execute R analysis in Rho when a task requires code, captured document execution, queue or stdin interaction, and authoritative result verification.
---

Choose an analysis method from the scientific question, observed data, and available capabilities. Explain assumptions that affect interpretation. Rho permits generated R code and ordinary file or process operations when the task calls for them; structured reads help inspect familiar data without inventing repeated probing programs.

Bind execution to the observed logical instance and native session and retain the original request ID. When the Host advertises instance-aware capabilities, include `workspace_instance_id` from `runtime.instances` or the explicit application context. Capture that target with the code; later view selection must not retarget the request. Acceptance, running, terminal completion, and cancellation request are different states. Determine success from the authoritative operation outcome and relevant result evidence.

For document execution, work with the captured text and expected versions. Saving and running a file requires successful save evidence whose digest matches the capture before execution. Later user input belongs to the continuing draft. It must not change the submitted capture or be overwritten by an earlier save acknowledgement.

When working alongside a Studio user, keep substantial analysis code in an Editor document. `application.control` supports `create_document`, `edit_document`, `run_file` and `run_selection`; obtain current identities from `application.context` and follow the original `application.command_status` receipt to its scientific operation. This makes the code and its execution visible and reusable without a separate R process.

For a plot the user asks to see, display it on the active Rho device (for example `print(p)` for a ggplot/ggtree object). Saving with `ggsave()` alone does not emit a Plots result. Verify retained media through `workspace.list_outputs` and `output.view`, and select the exact operation/sequence in Studio with `application.control` / `select_plot`. A path in stdout does not establish an output reference or a visible plot.

Use queue, pause, stdin, and cancellation capabilities according to their described state and identity preconditions. A cancellation request does not prove that native execution stopped or effects were rolled back.

Each R instance has its own queue and input. Scope console-state reads and queue controls to the producing instance, and answer stdin using its original native request. If a target is restoring or needs attention, inspect that lifecycle receipt and recovery coverage rather than submitting the analysis to another instance. Object restoration is a separate recorded action; it is not evidence that previous analysis completed.

R submissions return acceptance promptly over MCP by default. For a nonterminal receipt, inspect `workspace.console_state` to distinguish running, queued, paused and waiting for input. A failed run may have paused the queue; waiting does not clear that pause. After inspecting the failed result, explicitly resume its observed pause when the pending work should continue. Never repeat an accepted submission to make it run.

Verification should test the claim the analysis will make: inspect relevant resulting values, files, artifacts, or environment receipts. Discuss uncertainty and alternatives when the data permit several interpretations. Preserve code and result identities so another Agent can investigate the same evidence.
