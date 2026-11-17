# Rho positioning brief

状态：literature-informed draft。28 篇 corpus 论文已完成全文相关章节深读。当前 brief 说明可检验定位，尚未宣称普遍创新性或人类收益。

## Target reader

研究工作台与 HCI 读者，关心人和 Agent 如何在长时间、跨会话的研究任务中共同理解、修改和继续工作。Rho 的科学讨论需要同时让系统研究者、研究软件开发者和真实分析人员读得懂。

## Problem

长程研究工作跨越代码、数据、Notebook、表格、图、运行、对话、决定和开放问题。下一位参与者要继续工作，必须知道当前目的、已完成的动作、结果来自什么版本、哪些内容仍不确定，以及哪些步骤可以安全重做。

现有 28 篇论文覆盖了五种主要评估传统。

| Literature cluster | What it measures well | What remains outside its main unit | Rho relation |
| --- | --- | --- | --- |
| Executable benchmarks: Jericho, TextWorld, ALFWorld, WebShop, InterCode, SWE-bench, USACO, DevBench, WebArena, World of Bits, MiniWoB++, BabyAI | Task success, reward, execution result, generalization, sample efficiency and reproducibility of an environment | Whether another person can understand and continue the work, and how purpose and evidence survive a handoff | Rho can reuse explicit task units and owner-defined checks while adding shared work-state continuity |
| Agent mechanisms: CALM, ReAct, Reflexion, FireAct, Tree of Thoughts, CoALA, RecMind, Tree of Attacks | Candidate generation, reasoning, memory, search, feedback, tool use and query cost | Long-running project state shared between people and Agents | Rho is a state and evidence layer around these mechanisms, rather than a new reasoning policy |
| Human or expert evaluation: WebGPT, USACO tutoring, ChemCrow, DevBench design review | Human preference, tutoring effects, expert judgement, references and domain assessment | Persistent ownership, cross-session reconstruction and the cost of continuing someone else's work | Rho needs direct comprehension and recovery measures, with domain owners retaining scientific judgement |
| Real-world or online validation: WebShop transfer, WebAgent, SeeAct, Pix2Act | Differences between simulated, offline and live environments; grounding and action execution | How a live work state is handed to a new participant after partial failure | Rho should report offline records, live actions and handoff outcomes separately |
| Baselines and reasoning foundations: GPT-3, Chain-of-Thought, HumanEval | Scaling, in-context reasoning, functional correctness and contamination concerns | Open-ended research quality and multi-participant continuity | Rho must control model version and task exposure so model capability is not mistaken for a Rho effect |

## Literature-derived evaluation lessons

1. **Automatic checks are strongest when the task has an executable or structured ground truth.** WebShop uses attribute matching, InterCode uses execution and state changes, SWE-bench and USACO use tests, and WebArena uses functional task checks. These metrics are precise for their task unit but do not cover every research judgement.
2. **Process evidence is valuable when the task is long or interactive.** InterCode reports turns and non-admissible actions. SWE-bench reports retrieval and patch application. Tree of Attacks reports target queries. ReAct and WebAgent inspect trajectories and failure modes.
3. **Human and expert checks are needed for open-ended quality.** WebGPT uses pairwise human preferences and references. ChemCrow combines LLM and expert assessment and shows that GPT-4 can fail as an evaluator. DevBench reports gaps between LLM-as-a-Judge and human majority labels.
4. **Offline scores can diverge from live behavior.** SeeAct reports different offline and online success rates. WebAgent and WebShop use real websites or sim-to-real transfer with extra conditions. Rho must record the environment and observation boundary for every result.
5. **A benchmark result is not a claim about a framework's practical value.** The papers isolate a task, a unit, a comparator and an evaluator. Rho needs the same discipline for continuity, comprehension and scientific work quality.

## Candidate contribution

Rho can be positioned as a shared work-state layer for long-running human-Agent research work. It connects goal, progress, resources, actions, results and open questions so a person or an external Agent can enter the same project, understand its current state, change it and continue it across a session or participant boundary.

The mechanism is explicit state and evidence continuity. A work state carries resource identities and versions, action ownership, result provenance, decisions, uncertainty and the next continuation point. The application composes native components and preserves their owners. Rho does not claim that the shared layer improves an Agent's reasoning model by itself.

## Candidate claims and evidence status

| Claim | Status | Existing support | Required evidence |
| --- | --- | --- | --- |
| Explicit shared work-state continuity reduces the work needed to reconstruct purpose, current version and next action after a handoff. | proposed | Rho architecture, continuity, graph, review and literature-reproduction episodes | Stage 1 capability comparison and Stage 2 researcher study |
| A useful continuation record must connect actions and results to the resource versions and decisions that give them meaning. | proposed | Rho provenance design and episodes; literature shows trajectory and execution records matter | Measure provenance completeness and correct explanation of changes |
| Rho's contribution is organization and continuation of heterogeneous work state, rather than a new agent reasoning method or benchmark. | proposed | Corpus separates agent mechanisms from task environments and evaluations | Broader adjacent-work review plus ablation against a native workflow |
| System success, researcher understanding and scientific validity require distinct evidence. | supported_as_method_rule | Rho Development and Architecture documents, WebGPT/ChemCrow/DevBench evaluation limits | Use separate outcomes and independent domain checks in both stages |
| Current Rho episodes establish bounded system behavior. | observed_in_rho | `docs/STATUS.md`, `docs/LITERATURE-REPRO-EPISODE.md`, continuity and review episodes | Repeated system runs under the declared protocol |

## Boundary

The corpus does not establish that Rho is the first shared-work-state system. A novelty claim requires a targeted review of HCI, CSCW, research-software, computational-notebook, provenance and human-AI collaboration literature. The current evidence does not establish independent researcher usability, general research efficiency, scientific correctness or broad human benefit.

## Positioning sentence for further testing

Rho proposes a shared work-state layer that makes long-running human-Agent research continuable by preserving the relation between purpose, resource versions, actions, results, decisions and uncertainty. Its value should be tested through handoff and recovery outcomes, then through a same-task comparison with the researcher's native workflow.

## Sources

- Rho: `docs/ARCHITECTURE.md`, `docs/STATUS.md`, `docs/ROADMAP.md`, `docs/DEVELOPMENT.md`, `docs/LITERATURE-REPRO-EPISODE.md`
- Corpus: `papers/00-INDEX.md`, `notes/05-topics/01-基准设计的三个判据.md`
- Paper IDs and locators: `paper-matrix.csv` and `paper-notes/`
