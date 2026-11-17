---
name: rho-task-map
description: Maintain a task map that shows work, evidence, decisions and the next step to a person.
---

# Rho task map

Describe the whole task yourself: Rho fixes no closed list of kinds or states.

1. task.map.declare carries stable item IDs, your own kind and state words (each a
   label, an optional tone and an optional role Rho understands: working, waiting,
   done, planned, unknown, stopped), titles you write, progress counted from real
   receipts, an optional layout view per item, and next only for steps you will take.
2. task.map.present changes a card form, its parameters (a subset), or the focus.
   People use the same call. A pinned target, or a change within agentFormIntervalMs
   of your last applied form change, is merged into one pending suggestion instead of
   being applied: the screen stays steady and the person applies it.
3. task.map.respond is the person only: pin, unpin, revert your form change (layout
   only, never the work), accept or dismiss a suggestion.
4. task.map.read observes. Reading never starts, resumes or reruns work.
5. Declare the map when you start, not when you are done, and declare again as the
   work moves: until then the person sees your calls but not their structure.
6. Name what an item rests on. As soon as artifact.check verifies a result, give the
   item artifact {id, version}; use from for an item that branches from another. Rho
   links an item to objects only through these references, never through its title.
7. Mark a line judgment: true when it is your reading of a result rather than
   something a record shows. It is shown as your judgment, never as verified.

A form declared zoom: false is reached only by naming it, so stepping up from a card
lands on the summary, not on compare.
