---
name: rho-analysis-execution
description: Prepare and execute R analysis in Rho when a task requires code, captured document execution, queue or stdin interaction, and authoritative result verification.
---

Choose an analysis method from the scientific question, observed data, and available capabilities. Explain assumptions that affect interpretation. Rho permits generated R code and ordinary file or process operations when the task calls for them; structured reads help inspect familiar data without inventing repeated probing programs.

Bind execution to the observed native session and retain the original request ID. Acceptance, running, terminal completion, and cancellation request are different states. Determine success from the authoritative operation outcome and relevant result evidence.

For document execution, work with the captured text and expected versions. Saving and running a file requires successful save evidence whose digest matches the capture before execution. Later user input belongs to the continuing draft. It must not change the submitted capture or be overwritten by an earlier save acknowledgement.

Use queue, pause, stdin, and cancellation capabilities according to their described state and identity preconditions. A cancellation request does not prove that native execution stopped or effects were rolled back.

Verification should test the claim the analysis will make: inspect relevant resulting values, files, artifacts, or environment receipts. Discuss uncertainty and alternatives when the data permit several interpretations. Preserve code and result identities so another Agent can investigate the same evidence.
