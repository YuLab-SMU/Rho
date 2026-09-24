# Console

An ordinary UI-only plugin bound to one exact R backend instance. View configuration
contains `source: InstanceRef`; a different revision or instance is never selected
implicitly. Open, save and close use the same public view lifecycle as other plugins.
Closing the view leaves accepted Operations and the native R session running.

The continuous selectable transcript reads original Operations, live ordered R events
and digest-verified retained events. Source labels describe submitted input; they do
not attest to a document capture. Clear View records observed event positions;
later output from the same active run still appears, and Show History restores
the retained transcript without executing anything.
The transcript retains at most 100 completed runs plus active work and labels that
limit; earlier original records remain in Operation history. Exhausted pagination
does not restart at the newest page or remove recent work.
Command input, selection, scroll and bounded history are view state. R stdin is a
separate, transient field; an answer is never saved as a command or resent on reconnect.

Pending-only cancellation uses the original Operation control and the R owner's atomic
queue fence. Interrupt is a separate action for running work. Queue observations keep
unconfirmed cancellation and original result settlement visible. A lost submission
acknowledgement retains its code and request identity for explicit retry.
The retained request also fixes its originating view identity. Copying that state
to a newly opened view cannot replay the original request under a different caller.

This package is under implementation. Full Console migration, cross-plugin plot
navigation, context contributions and native keyboard/IME acceptance remain part of
the unified-plugin work; standalone source does not establish those acceptance results.
