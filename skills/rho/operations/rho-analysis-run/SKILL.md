---
name: rho-analysis-run
description: Run long R and Python analyses so interruption preserves outputs, uncertainty and continuation state.
---

# Rho analysis run

A whole analysis has to survive interruption. Rho keeps no step cap and no wall time
by default, and a long analysis may still be stopped by the person or by the Agent
client, so write results as you go instead of holding them until the end.

1. Spend calls on the analysis, not on discovery. Resolve the operations you will use
   once each (kernel.run, kernel.read, kernel.interrupt, resource.list) and reuse the
   contractRef you were given. In the runs behind this Skill one Agent spent 36
   capability.index calls in a single analysis and ended with only its quality-control
   table written.
2. Do not guess what a result reference contains. A refused read means the shape is
   wrong, not that the result is missing: resolve the operation that produced it and
   read the page or range it names instead of trying sibling paths.
3. Nothing wakes you later. No monitor, timer or event resumes your turn: a cell still
   running when you stop is left running for nobody, and ending your reply is not
   proof the analysis finished. Pass a waitMs long enough for the slowest step (a
   normalisation over 90,000 nuclei can take many minutes), or read the cell with
   kernel.read in your own next call.
4. Load once, build on it. A session keeps what a cell defines, so read the data in one
   cell and derive in the next. A service restart does not keep those objects: the code
   and its outputs stay, the values in memory do not, so keep a script that rebuilds
   what matters.
5. Prefer a few large cells to many small ones, and keep each short enough to finish. A
   cell that hangs costs time: interrupt it with kernel.interrupt and continue with the
   part that is cheap to redo.
6. Draw to an explicit device. In these runs a ggsave call in the shared session hung
   and the figure had to be redrawn with png() and dev.off(): open the device, plot,
   close it, and let the figure land in a file you name.
7. Write each file once, complete, and save it to disk before you rely on it. One script
   written in full and then run costs less than the same script edited piece by piece,
   and a file on disk is the only version that outlives a stop. Run it in the session
   with kernel.run (source() in R, exec() in Python), not from a shell: a figure file
   stays readable mark by mark only while it holds the bytes a Notebook cell saved.
8. Check packages in one call, and do not install into a temporary library. Name what is
   missing, and when you substitute a gene-set source or an annotation build, say so
   beside the result, because that choice changes the numbers.
9. Say what did not reproduce, and why. When a published count cannot be matched, name
   the undefined choice (a threshold, a direction, a model) and compute the cheap
   alternatives beside your main one instead of tuning until it fits.
10. Report the state you actually reached. Say which outputs exist on disk, which cell
   was still running, and what a stopped turn left behind; the person continues from
   that record rather than from a claim that the work is done.
