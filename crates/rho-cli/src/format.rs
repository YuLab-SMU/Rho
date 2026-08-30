use rho_protocol::workbench::{
    ApprovalSummary, EnvironmentEvidence, OutputSummary, ProblemSummary, ProjectSummary,
    ProvenanceLink, RunDetail, RunSummary, WorkbenchCapabilities, WorkbenchPageInfo,
    WorkspaceStatus,
};

// ── Capabilities ─────────────────────────────────────────────────────────────

pub fn print_capabilities(caps: &WorkbenchCapabilities) {
    println!("Workbench Protocol: {}", caps.workbench_protocol_version);
    println!("Read-only: {}", caps.read_only);
    println!("Max page size: {}", caps.max_page_size);
    println!();
    println!("Operations:");
    for op in &caps.operations {
        println!("  {}", op);
    }
}

// ── Project ──────────────────────────────────────────────────────────────────

pub fn print_project(status: &ProjectSummary) {
    println!("Project: {}", status.project_id);
    println!("  Runs:      {}", status.total_run_count);
    println!("  Artifacts: {}", status.total_artifact_count);
    println!("  Plots:     {}", status.total_plot_count);
    println!("  Problems:  {}", status.unresolved_problem_count);
}

// ── Workspace ────────────────────────────────────────────────────────────────

pub fn print_workspace(status: &WorkspaceStatus) {
    println!("Workspace:      {}", status.workspace_id);
    println!("  Kernel:       {}", status.kernel_instance_id);
    println!("  Running:      {}", status.running);
    println!("  Exec seq:     {}", status.execution_seq);
    println!("  State rev:    {}", status.state_revision);
    println!("  Project rev:  {}", status.project_revision);
}

// ── Runs ─────────────────────────────────────────────────────────────────────

pub fn print_run_list(runs: &[RunSummary], page: &WorkbenchPageInfo) {
    if runs.is_empty() {
        println!("No runs found.");
        return;
    }
    for run in runs {
        let status_mark = if run.has_error { "✗" } else { "✓" };
        println!(
            "{}  {}  {:12}  {:12}  {}",
            status_mark,
            &run.run_id[..run.run_id.len().min(12)],
            run.status,
            run.origin,
            run.request_type,
        );
        if let Some(ref src) = run.source_path {
            println!("    source: {}", src);
        }
    }
    if page.has_more {
        println!("  ... (more pages available)");
    }
}

pub fn print_run_detail(detail: &RunDetail) {
    let s = &detail.summary;
    println!("Run:           {}", s.run_id);
    println!("  Origin:      {}", s.origin);
    println!("  Status:      {}", s.status);
    println!("  Started:     {}", s.started_at);
    if let Some(ref f) = s.finished_at {
        println!("  Finished:    {}", f);
    }
    if let Some(ref err) = detail.error_message {
        println!("  Error:       {}", err);
    }
    if let Some(ref code) = detail.code_preview {
        println!("  Code:");
        for line in code.lines().take(20) {
            println!("    {}", line);
        }
        if detail.code_truncated {
            println!("    ... (truncated)");
        }
    }
    if let Some(ref out) = detail.stdout_preview
        && !out.is_empty()
    {
        println!("  Output:");
        for line in out.lines().take(20) {
            println!("    {}", line);
        }
        if detail.stdout_truncated {
            println!("    ... (truncated)");
        }
    }
    if !detail.warnings.is_empty() {
        println!("  Warnings:");
        for w in &detail.warnings {
            println!("    - {}", w);
        }
    }
}

// ── Problems ─────────────────────────────────────────────────────────────────

pub fn print_problem_list(problems: &[ProblemSummary], page: &WorkbenchPageInfo) {
    if problems.is_empty() {
        println!("No problems found.");
        return;
    }
    for p in problems {
        println!(
            "{}  {:12}  {}",
            p.severity,
            &p.problem_id[..p.problem_id.len().min(12)],
            p.title,
        );
        if let Some(ref src) = p.source_path {
            println!("    source: {}", src);
        }
    }
    if page.has_more {
        println!("  ... (more pages available)");
    }
}

pub fn print_problem(p: &ProblemSummary) {
    println!("Problem:    {}", p.problem_id);
    println!("  Severity: {}", p.severity);
    println!("  Run:      {}", p.run_id);
    println!("  Title:    {}", p.title);
    if let Some(ref src) = p.source_path {
        println!("  Source:   {}", src);
    }
    println!("  Recorded: {}", p.recorded_at);
}

// ── Outputs ──────────────────────────────────────────────────────────────────

pub fn print_output_list(outputs: &[OutputSummary], page: &WorkbenchPageInfo) {
    if outputs.is_empty() {
        println!("No outputs found.");
        return;
    }
    for o in outputs {
        let prov = if o.provenance_complete { "✓" } else { "?" };
        println!(
            "{}  {:12}  {:10}  {:10}",
            prov,
            &o.artifact_id[..o.artifact_id.len().min(12)],
            o.artifact_kind,
            o.media_type,
        );
        if let Some(ref path) = o.output_path {
            println!("    path: {}", path);
        }
    }
    if page.has_more {
        println!("  ... (more pages available)");
    }
}

pub fn print_output(o: &OutputSummary) {
    println!("Artifact:     {}", o.artifact_id);
    println!("  Kind:       {}", o.artifact_kind);
    if let Some(ref rid) = o.run_id {
        println!("  Run:        {}", rid);
    }
    if let Some(ref path) = o.output_path {
        println!("  Path:       {}", path);
    }
    println!("  Media:      {}", o.media_type);
    println!("  Created:    {}", o.created_at);
    println!(
        "  Provenance: {}",
        if o.provenance_complete {
            "complete"
        } else {
            "incomplete"
        }
    );
    if let Some(ref reason) = o.incomplete_reason {
        println!("  Reason:     {}", reason);
    }
}

// ── Environment ──────────────────────────────────────────────────────────────

pub fn print_env_list(evidence: &[EnvironmentEvidence], page: &WorkbenchPageInfo) {
    if evidence.is_empty() {
        println!("No environment evidence found.");
        return;
    }
    for e in evidence {
        println!(
            "{:18}  {:12}  {}",
            e.evidence_kind,
            &e.evidence_id[..e.evidence_id.len().min(12)],
            e.operation_name.as_deref().unwrap_or("—"),
        );
    }
    if page.has_more {
        println!("  ... (more pages available)");
    }
}

pub fn print_env(e: &EnvironmentEvidence) {
    println!("Evidence:   {}", e.evidence_id);
    println!("  Kind:     {}", e.evidence_kind);
    if let Some(ref name) = e.operation_name {
        println!("  Operation: {}", name);
    }
    if let Some(ref status) = e.operation_status {
        println!("  Status:   {}", status);
    }
    if let Some(ref decision) = e.operation_decision {
        println!("  Decision: {}", decision);
    }
    println!("  Captured: {}", e.captured_at);
}

// ── Approvals ────────────────────────────────────────────────────────────────

pub fn print_approval_list(approvals: &[ApprovalSummary], page: &WorkbenchPageInfo) {
    if approvals.is_empty() {
        println!("No approvals found.");
        return;
    }
    for a in approvals {
        let dec = a.decision.as_deref().unwrap_or("—");
        println!(
            "{:12}  {:10}  {:6}  {:12}",
            &a.request_id[..a.request_id.len().min(12)],
            a.tool,
            a.status,
            dec,
        );
    }
    if page.has_more {
        println!("  ... (more pages available)");
    }
}

pub fn print_approval(a: &ApprovalSummary) {
    println!("Approval:   {}", a.request_id);
    println!("  Turn:     {}", a.turn_id);
    println!("  Tool:     {}", a.tool);
    println!("  Policy:   {}", a.policy);
    println!("  Status:   {}", a.status);
    if let Some(ref dec) = a.decision {
        println!("  Decision: {}", dec);
    }
    if let Some(ref reason) = a.reason {
        println!("  Reason:   {}", reason);
    }
    println!("  Requested: {}", a.requested_at);
    if let Some(ref resp) = a.responded_at {
        println!("  Responded: {}", resp);
    }
}

// ── Provenance ───────────────────────────────────────────────────────────────

pub fn print_provenance(link: &ProvenanceLink) {
    println!("Resource:        {}", link.resource_id);
    if let Some(ref rid) = link.producing_run_id {
        println!("  Producing run: {}", rid);
    }
    if let Some(ref sid) = link.environment_snapshot_id {
        println!("  Environment:   {}", sid);
    }
    if let Some(ref src) = link.source_path {
        println!("  Source:        {}", src);
    }
    println!("  Complete:      {}", link.provenance_complete);
    if let Some(ref reason) = link.incomplete_reason {
        println!("  Reason:        {}", reason);
    }
}
