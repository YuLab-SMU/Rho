# Live sessions on a server

The request (2026-10-31): much of the computing happens on a remote server; add support for
it and the components to work with it. This records what was built and the episode that
checked it. Rho-plugins owns the sessions (Notebook 0.2.0); Rho owns the views. A second
request the same day moved how each server is used into the server's own skills; see
[Servers' own skills](#servers-own-skills) (Notebook 0.3.0).

## What a person and an Agent can do now

- **Name a place.** A place is a folder on a server that ssh reaches the way the person's
  own terminal does: a Host from their ssh config, `user@host` or `ssh://user@host:port`.
  It also has a folder there (`~/…` or absolute) and setup lines run in that folder first
  (`module load R`, `conda activate env`). The person adds one in the Servers view; an Agent
  does the same with `kernel.place.set`. ssh runs in batch mode, so it never asks for a
  password or accepts a new host key; what ssh says is what is shown.
- **Check it.** `kernel.place.check` connects and reports what it saw: the system, the
  machine's name, the folder as the server resolved it, R with jsonlite, Python with
  matplotlib, the time taken and who checked. This is kept with the place until the place
  changes.
- **Run there.** Each language's next session starts where the project marks it (`use`;
  this machine unless chosen); a cell may also name a place. A cell that names another
  place than where its language's live session runs is refused, because its values stay
  where they are. The R and Python sessions are the same ones the Notebook already had:
  cells, output, plots, variables, inspect, interrupt, stop, and Data flow's records of
  what each cell read and made. Paths in a session are its place's folder.
- **Look at its files.** `kernel.place.list` lists a folder within the place's folder.
  Opening a file copies it into the project at `remote/<place>/<path>`, recording its size,
  time on the server and SHA-256 (`kernel.place.copy`), and it then opens in its own
  viewer. A copy changed here is never replaced. A listing marks a copy whose file on the
  server has changed since ("Changed · copy again").
- **See where everything runs.** The Notebook's line has a chip beside the language
  ("Lab server") to choose where the language's next session starts. Session marks,
  session rows, the console bar, Variables and Data flow name the place. A file named in a
  server session's Data flow opens in the Servers view at its folder there.

## How it works

The session's process is the same runner as on this machine, started by
`ssh -T -o BatchMode=yes … -- <destination> 'bash -lc …'`. The login shell gives R and
Python the environment the person's terminal has there; a lab cluster's notes record that
plain `ssh host cmd` often finds nothing without it. The runner is sent on the session's
own input (`head -c`) into `~/.cache/rho/kernel/runner-<digest>`; nothing else is installed.

Locally the runner answers on file descriptor 3. ssh carries only two streams back, so on
a server the answers go to standard output (`3>&1`) and what the code prints goes to
standard error (`1>&2`). A login shell's notices on standard output (`gcc 9.3.0 loaded`)
are not JSON and are skipped. Plots are drawn in the session's temporary folder there and
sent base64 with their answers.

One connection per server is shared (`ControlMaster`, sockets in `/tmp/rho-ssh-<uid>`).
Interrupt and stop signal the session's process group there through it: `ps -o pgid=`,
then `kill -INT -<pgid>`. Keepalives (15 s × 4) notice a dead connection, and ssh then ends
with 255. The session ends as `disconnected` and its running cell is `unknown`, because its
process there was not seen to end. Nothing is run again; the next cell starts a new
session with a new identity.

## The episode

**Resources.** A disposable server: a Debian bookworm container (OrbStack) with sshd,
R 4.2.2 with jsonlite and DESeq2 1.38.3, Python 3.11.2 with matplotlib and pandas. Its login
profile prints module notices on standard output, as a cluster's does. Access is by a
disposable key through an ssh config of its own, which the service took as `--ssh` (a
wrapper calling `ssh -F`). The bix-46 capsule's data (two DESeqResults `.rds` files and
the PA14 annotation, 1.7 MB) were put only on the server. The project on this machine,
`remote-rnaseq`, started empty. A Rho service from source ran on `/tmp/rho-cases`, with
headless Chrome at 1440 × 900.

**Run, in the browser as the person.**

1. Studio → Add view → Servers. Add a server: ssh name `rho-remote`, folder `~/rnaseq`,
   name "Lab server". Add and check: `Linux aarch64 · R 4.2.2 · Python 3.11.2`, 0.3 s.
2. "New sessions: R" on Lab server. Files → `data/` listed the three files with sizes and
   times.
3. Add view → Notebook. The line showed `R` and `Lab server` chips. Cells loaded DESeq2
   and the data there, merged, printed mexG at −4.964225 (the capsule's answer, as on this
   machine), drew the volcano plot and wrote `out/significant_1vs97.csv` there. The plot
   showed in the Notebook. The Servers card showed the live session, the host's name and
   its process.
4. Data flow: the boxes read `res_1vs97.rds`, `res_1vs98.rds` and the annotation, then made
   `ann`, `res97`, `d97`, `m`, the plot and the written CSV. Pressing the CSV switched to
   Servers at `~/rnaseq/out` with that file highlighted. Opening it copied 268,409 bytes to
   `remote/lab-server/out/significant_1vs97.csv` and showed it as a 2,091-row table.
5. Explore in R from that table loaded `out/significant_1vs97.csv` in the server session
   (2091 × 8). For `samples.csv`, a file only on this machine, Rho said where each was and
   ran nothing.
6. A cell counting to 300 a second at a time; the container was taken off the network
   after five. 75 s later the cell read *Outcome unknown*, and the session mark said the
   connection to Lab server was lost and its process (1741) was not seen to end. The
   Servers card said the cell may have gone on there. Back on the network, no R was left
   on the server.
7. Stopping the service ended the server session (its input closed); no R was left.

**Observed and changed in their owners.**

- Interrupt did nothing: dash, Debian's `sh`, rejects `kill -INT -- -<pgid>`. The command
  is now `kill -INT -<pgid>`, which dash and bash both take.
- A lost connection's message quoted the cell's own output ("1 2 3 4"). ssh's message
  goes to the shared master, not the session. The message now says only what was
  observed.
- Sizes read `5984 <c3><97> 21`: a login without a UTF-8 locale (none set, or the
  client's locale not installed there) leaves R in C. A session whose character set is not
  UTF-8 now takes a UTF-8 `LC_CTYPE` the server has (C.UTF-8, en_US.UTF-8); a set
  `LC_ALL` is kept. The test reproduces it: `2 <c3><97> 2` before, `2 × 2` after.
- Listing times kept fractions and a copy's did not, so an unchanged copy would read as
  changed. Both are now whole seconds.
- The Servers view was refused at first: the local browser's grant lacked the new
  operations. They are now in its `kernelMethods`; Agents receive them as any operation.
- The bare `R`/`Python` pills on each card did not say what pressing them meant; they now
  follow "New sessions". In a narrow pane they hid the place's name, and file names were
  centred by the shared button style; both are fixed.
- Explore in R loaded a local path in the server session ("cannot open file"). It now
  loads a copy's original there and refuses a file that is only on this machine.
- The lost session's mark said the same thing twice; the second line now names only the
  process there.

**Agent trial.** In a fresh project with no places, Claude Code (Claude Haiku 5.5, started
in Rho) was asked in plain words to work on `rho-remote` in `~/rnaseq/data` and report
mexG in `res_1vs98.rds`. It first used its own shell: `ls -la`, then `grep` for
`rho-remote` in `~/.ssh/config`, where that disposable alias is not. Its next command
waited for the person's choice, which was left unanswered. Whether an Agent finds and uses
the places without being told is not observed.

## Checks

- Notebook tests (Rho-plugins): with a stand-in ssh that runs the command here in its own
  process group, under a test home and a C locale. They cover a session on a place,
  setup lines, inline plots, inspect, interrupt over ssh, the place conflict, listing and
  copying, link and parent refusals, conflict on a changed copy, removal while a session
  runs, a lost connection (ssh ending with 255) leaving the cell unknown and running
  nothing again, and an unreachable place reporting what ssh said. Rho-plugins 144/144.
- Rho: contracts regenerated (the five operations, `place`, `host`, `disconnected`) and
  checked; Rho 272/274, with the MCP v2 test cancelled at its 30 s limit and a Codex
  restart test's cleanup race, both passing alone. The sources, ui:u2, agent-canvas, graph,
  agent-page, agent-ui, review and person-files acceptances passed; shell and interaction
  failed as before this pass (see [Status](STATUS.md)).

## Limits and open questions

- Only an ssh-reachable, sh-compatible login with `bash`, `head -c` and `ps` was exercised,
  on Linux. A csh login shell, a Windows server and a server reached only by password were
  not tried (batch mode refuses passwords; ssh's own message is shown).
- Sessions end with Rho, and when the connection drops, as on this machine. A session that
  goes on running on the server after a drop, and reattaching to one, were not observed:
  both times the server ended the process. A process left running after a drop has no way
  to be found or ended from Rho yet.
- Compute nodes behind a scheduler (`srun`, `sbatch`) are not places yet. A session runs
  on the machine ssh reaches, which on a cluster is a login node.
- Standard output and error of a server session are one stream (`cat(file = stderr())`
  reads as output). R messages and warnings are still told apart.
- Files reach the project one at a time, up to 64 MiB each; nothing is sent from this
  machine to a server. A link that leads out of the place's folder is not followed, even
  to scratch space on the same server.
- The real lab cluster was not used. Its notes record module notices on standard output
  and logins that fail before key exchange; the first is handled, the second shows as
  ssh's message.
- No independent person has used these screens.

## Servers' own skills

The request (2026-10-31, later): strengthen the use of servers through their own skills
instead of details written into Rho, with the components working with those skills.

The person already keeps their servers in serverctl (ssh-server-manager): it holds each
server's login in the system's vault and its connection settings, and binds skills to a server,
such as `yulab-slurm-jobs` to YuLabServer. Its own rules forbid plain ssh to a server it
manages. Before this pass the kernel reached every server with plain ssh, carried one cluster's
module notices in a filter, and knew nothing of a server's skills; the person typed setup lines
from memory.

**What changed.**

- A server serverctl manages is reached through `serverctl exec`, never with ssh beside it. A
  place named without `via` goes through serverctl when serverctl manages a server of that name
  (spelled as serverctl spells it), and with ssh otherwise; a place reached through serverctl
  stays with it when it is changed on the same server, even while serverctl cannot be asked
  (found reading the change: an edit then would have gone to plain ssh). Every command, the session's
  included, is sent as words that serverctl quotes for the server's shell, with `--reuse 60`, so
  checking, listing and interrupting share one connection. A session lasts at most serverctl's
  limit for one command, set to 7 days. serverctl's audit log records each command Rho ran there.
- `kernel.servers` reads serverctl's registry without connecting: each server's name, system and
  tags, and the skills bound to it with serverctl's status. A server's address and account are not
  passed on. `kernel.server.skill` reads one skill's `SKILL.md` (up to 256 KiB). serverctl resolves
  a server's skills together and fails when one is missing or invalid; then none is read.
- The Agent's instructions: read a server's skills before naming a place or running code there,
  follow them (for example in the place's setup lines), and take them as guidance that grants
  nothing.
- The Servers view: Add a server lists the servers serverctl manages with their system and number
  of skills; choosing one says it is reached through serverctl and shows its skills, and a skill
  reads in place. A place card says "through serverctl" and shows its skills ("How it is used"). A
  check that finds no R where the server has skills says they may say how to set it up.
- The kernel's filter for one cluster's module notices in failure messages is gone; what ssh or
  serverctl said last is shown.

**Resources.** The same disposable Debian container, changed to stand for a cluster: R moved off
the default path behind `/opt/lab/modules/R-4.2.sh` (as `module load` gives it), `~/rnaseq/data`
made read-only. serverctl from its current source, with a throwaway registry, runtime folder and
managed config (`SSM_DATA_DIR`, `SSM_RUNTIME_DIR`, `SSM_MANAGED_SSH_CONFIG`; the person's own
registry and `~/.ssh` untouched). The container was imported from its test ssh config, and a skill
`rho-remote-lab` was written for it and bound to it: R only after the module line, data
read-only, results to `~/rnaseq/out`, keep to 2 cores. A Rho service from source took
`--serverctl`; headless Chrome at 1440 × 900.

**Run, as the person.**

1. Servers → Add a server listed `rho-remote · 1 skill`. Choosing it said "Reached through
   serverctl, which holds its login" and showed `rho-remote-lab`; pressing it read the skill in
   the form.
2. Added without setup lines: `Linux aarch64 · no R · Python 3.11.2`, 0.3 s, with the line about
   the skills.
3. Edit, the skill's line `. /opt/lab/modules/R-4.2.sh`, Save and check: `R 4.2.2`. New R sessions
   on Lab server.
4. Notebook: the bix-46 cells ran there through serverctl, the plot showed, mexG −4.964225 (1 vs
   97), the CSV written to `out/`.
5. A cell counting a second at a time; the container taken off the network. 45 s later
   (serverctl's keepalives, 15 s × 2) the cell was unknown and the session disconnected, its
   process there not seen to end. Back on the network no R was left there, and a check passed in
   0.4 s.

**Run, as an Agent.** In a fresh project with no places, the same plain question twice:
"My server rho-remote has DESeq2 results in ~/rnaseq/data. What is the log2 fold change of mexG
in res_1vs98.rds? Also save the genes with padj < 0.05 from that comparison as a CSV on the
server."

- Claude Code started in Rho (Claude Haiku 5.5): it loaded the person's own `ssh-server-manager`
  skill and ran its own shell (`ls`, through the person's command hook); that command waits for
  the person's choice, left unanswered. Whether it would reach Rho's places was not observed.
- Claude Code with Rho's four tools only, no shell and no user settings (Claude Opus 5.5, as the
  acceptance scripts run it): `kernel.servers`, then "I've found the server; now I'm reading its
  lab skill", `kernel.server.skill`, `kernel.place.set` with `via: serverctl`, folder `~/rnaseq`
  and setup `. /opt/lab/modules/R-4.2.sh`, a check, three cells there. It wrote
  `out/res_1vs98_padj0.05.csv`, said it followed the skill (data read-only, results in `out`), and
  answered mexG 0.0715 (padj 0.805) and 2,910 genes. Recomputed on the server: 0.0715286,
  0.804655, 2,910 rows all below 0.05; `data/` unchanged. The place, its skill, the Agent's check
  and its session showed in the Servers view.

**The person's own registry,** read without connecting: serverctl on this machine's path (the copy
`~/.claude/skills/ssh-server-manager` links to) answered "database schema 8 is newer than
supported 5", and Rho shows that as it is. The current serverctl listed 13 servers;
`yulab-slurm-jobs` is bound to YuLabServer and read in full. `yulab-server`, the cluster's manual,
is a skill of the Agent but not bound to YuLabServer in serverctl, so Rho does not show it there.

**Observed and changed.** The check line said "set these up" when R itself was missing; it now
names R. "Named by An Agent" now reads "an Agent".

**Checks.** Rho-plugins 145/145, with a stand-in serverctl that keeps a registry in a file and
runs the words after `--` here: the servers and skills without addresses, a skill read by name,
a place named without `via` going through serverctl, its check, a cell with the setup line,
interrupt through serverctl, each command on a shared connection, a session at serverctl's
limit, a missing skill withholding the server's skills, serverctl's own error, a place
changed while serverctl cannot be asked staying with it, and serverctl missing. Rho: contracts
regenerated and checked; 271 to 272 of 274 in three full runs, the failures load and cleanup
races that pass alone (see [Status](STATUS.md)).

**Limits and open questions.**

- Only skills bound in serverctl are shown; a server reached with plain ssh has none here.
  Whether a place should name skills itself was not needed in this episode.
- A skill is guidance read by the Agent and the person; Rho reads nothing in it as settings.
  Whether a server's skill should give the components something they apply themselves (setup,
  a scheduler to start sessions on compute nodes) is open: it has not been needed yet, and on
  YuLabServer sessions would still start on the login node.
- Whether Claude Code started in Rho, with its own shell and the person's skills, uses the
  places and reads a server's skill was not observed: its first command waits on the person.
- The real cluster was not connected to.

