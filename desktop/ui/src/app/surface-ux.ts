export type SurfaceAreaRole = "primary" | "support" | "context" | "strip" | "developer";
export type SurfaceCatalogVisibility = "primary" | "contextual" | "internal" | "developer";
export type SurfaceFlowStage = "work" | "run" | "results" | "collaborate" | "project" | "developer";
export type SurfaceCapabilityGroup =
  | "workbench"
  | "workspace_r"
  | "results"
  | "agent"
  | "project_integration"
  | "project_extension"
  | "developer";

export interface SurfaceCatalogPolicy {
  readonly visibility: SurfaceCatalogVisibility;
  readonly capabilityGroup: SurfaceCapabilityGroup;
  readonly flowStage: SurfaceFlowStage;
  readonly composeOrder: number;
  readonly handoffTargets: readonly string[];
}

export const COMPOSE_FLOW_STAGES: Readonly<Record<
  Exclude<SurfaceFlowStage, "developer">,
  { readonly label: string; readonly description: string }
>> = {
  work: { label: "Work", description: "Find and edit project material." },
  run: { label: "Run", description: "Execute code in Workspace R." },
  results: { label: "Results", description: "Inspect outputs and durable execution history." },
  collaborate: { label: "Collaborate", description: "Direct Agent work and review its handoffs." },
  project: { label: "Project", description: "Maintain dependencies and source control." },
};

export const SURFACE_CAPABILITY_GROUPS: Readonly<Record<
  Exclude<SurfaceCapabilityGroup, "project_extension" | "developer">,
  { readonly label: string; readonly description: string }
>> = {
  workbench: {
    label: "Core Workbench",
    description: "Project navigation, documents, settings, and contextual guidance.",
  },
  workspace_r: {
    label: "Workspace R",
    description: "Ark-backed execution, Console transcripts, Runtime state, and project environments.",
  },
  results: {
    label: "Results & Verification",
    description: "Runs, Plots, Problems, checks, evidence, rendering, and diagnostics.",
  },
  agent: {
    label: "Agent Collaboration",
    description: "Agent conversations, reviewed changes, and Studio result-scene composition.",
  },
  project_integration: {
    label: "Project Integration",
    description: "Source control and bounded integrations owned by the active project.",
  },
};

export const FIRST_PARTY_SURFACE_CATALOG: Readonly<Record<string, SurfaceCatalogPolicy>> = {
  "rho.navigator": {
    visibility: "primary", capabilityGroup: "workbench", flowStage: "work", composeOrder: 0,
    handoffTargets: ["rho.file-source", "rho.runs"],
  },
  "rho.file-source": {
    visibility: "primary", capabilityGroup: "workbench", flowStage: "work", composeOrder: 10,
    handoffTargets: ["rho.console"],
  },
  "rho.file-preview": {
    visibility: "contextual", capabilityGroup: "workbench", flowStage: "work", composeOrder: 11,
    handoffTargets: [],
  },
  "rho.console": {
    visibility: "primary", capabilityGroup: "workspace_r", flowStage: "run", composeOrder: 20,
    handoffTargets: ["rho.plots", "rho.runs"],
  },
  "rho.status": {
    visibility: "internal", capabilityGroup: "workspace_r", flowStage: "run", composeOrder: 21,
    handoffTargets: [],
  },
  "rho.plots": {
    visibility: "primary", capabilityGroup: "results", flowStage: "results", composeOrder: 30,
    handoffTargets: ["rho.agent"],
  },
  "rho.runs": {
    visibility: "primary", capabilityGroup: "results", flowStage: "results", composeOrder: 40,
    handoffTargets: ["rho.file-source", "rho.agent"],
  },
  "rho.jobs": {
    visibility: "contextual", capabilityGroup: "results", flowStage: "results", composeOrder: 41,
    handoffTargets: ["rho.runs"],
  },
  "rho.artifacts": {
    visibility: "contextual", capabilityGroup: "results", flowStage: "results", composeOrder: 42,
    handoffTargets: ["rho.runs", "rho.plots"],
  },
  "rho.approvals": {
    visibility: "contextual", capabilityGroup: "results", flowStage: "results", composeOrder: 43,
    handoffTargets: ["rho.agent"],
  },
  "rho.revisions": {
    visibility: "contextual", capabilityGroup: "results", flowStage: "results", composeOrder: 44,
    handoffTargets: ["rho.runs"],
  },
  "rho.problems": {
    visibility: "contextual", capabilityGroup: "results", flowStage: "results", composeOrder: 45,
    handoffTargets: ["rho.runs", "rho.file-source"],
  },
  "rho.check-result": {
    visibility: "contextual", capabilityGroup: "results", flowStage: "results", composeOrder: 46,
    handoffTargets: ["rho.file-source", "rho.claims"],
  },
  "rho.claims": {
    visibility: "contextual", capabilityGroup: "results", flowStage: "results", composeOrder: 47,
    handoffTargets: ["rho.claim-trace", "rho.evidence-graph", "rho.evidence-gaps"],
  },
  "rho.evidence-graph": {
    visibility: "contextual", capabilityGroup: "results", flowStage: "results", composeOrder: 48,
    handoffTargets: ["rho.claim-trace"],
  },
  "rho.evidence-gaps": {
    visibility: "contextual", capabilityGroup: "results", flowStage: "results", composeOrder: 49,
    handoffTargets: ["rho.claims"],
  },
  "rho.claim-trace": {
    visibility: "contextual", capabilityGroup: "results", flowStage: "results", composeOrder: 50,
    handoffTargets: ["rho.claims", "rho.file-source", "rho.runs"],
  },
  "rho.logs": {
    visibility: "contextual", capabilityGroup: "results", flowStage: "results", composeOrder: 51,
    handoffTargets: [],
  },
  "rho.agent": {
    visibility: "primary", capabilityGroup: "agent", flowStage: "collaborate", composeOrder: 60,
    handoffTargets: ["rho.file-source", "rho.console", "rho.plots", "rho.runs"],
  },
  "rho.environment": {
    visibility: "primary", capabilityGroup: "workspace_r", flowStage: "project", composeOrder: 70,
    handoffTargets: ["rho.console"],
  },
  "rho.git": {
    visibility: "primary", capabilityGroup: "project_integration", flowStage: "project", composeOrder: 80,
    handoffTargets: ["rho.file-source"],
  },
  "rho.help": {
    visibility: "contextual", capabilityGroup: "workbench", flowStage: "project", composeOrder: 90,
    handoffTargets: [],
  },
  "rho.settings": {
    visibility: "internal", capabilityGroup: "workbench", flowStage: "project", composeOrder: 91,
    handoffTargets: [],
  },
  "rho.surface-playground": {
    visibility: "developer", capabilityGroup: "developer", flowStage: "developer", composeOrder: 999,
    handoffTargets: [],
  },
};

export interface SurfaceUxProfile {
  readonly label: string;
  readonly primaryTask: string;
  readonly defaultFocus: string;
  readonly primaryAction: string | null;
  readonly actionBudget: 1 | 2 | 3;
  readonly areaRole: SurfaceAreaRole;
  readonly narrowBehavior: "retain" | "collapse" | "stack" | "strip";
  readonly emptyState: string;
}

export const FIRST_PARTY_SURFACE_UX: Readonly<Record<string, SurfaceUxProfile>> = {
  "rho.agent": {
    label: "Agent", primaryTask: "Review and direct project work", defaultFocus: "Composer",
    primaryAction: "Send", actionBudget: 3, areaRole: "context", narrowBehavior: "collapse",
    emptyState: "Start by asking about the current project.",
  },
  "rho.check-result": {
    label: "Check result", primaryTask: "Review project findings", defaultFocus: "First finding",
    primaryAction: "Open evidence", actionBudget: 2, areaRole: "context", narrowBehavior: "collapse",
    emptyState: "Run a project check to create findings.",
  },
  "rho.console": {
    label: "R Console", primaryTask: "Run R code and inspect results", defaultFocus: "Code composer",
    primaryAction: "Run", actionBudget: 2, areaRole: "support", narrowBehavior: "retain",
    emptyState: "Ready for R code.",
  },
  "rho.environment": {
    label: "Environment", primaryTask: "Review verified realization, Workspace activation, exact plans, activity, and incidents", defaultFocus: "Authority health",
    primaryAction: "Refresh", actionBudget: 2, areaRole: "context", narrowBehavior: "collapse",
    emptyState: "Environment and resource state appears after inspection.",
  },
  "rho.claims": {
    label: "Claims", primaryTask: "Review and promote project claims", defaultFocus: "First claim",
    primaryAction: "Draft claim", actionBudget: 2, areaRole: "support", narrowBehavior: "stack",
    emptyState: "Draft and promoted claims will appear here.",
  },
  "rho.evidence-graph": {
    label: "Evidence graph", primaryTask: "Traverse claim relationships", defaultFocus: "Graph root",
    primaryAction: "Refresh", actionBudget: 2, areaRole: "support", narrowBehavior: "stack",
    emptyState: "Select a claim to inspect its graph neighborhood.",
  },
  "rho.evidence-gaps": {
    label: "Evidence gaps", primaryTask: "Review deterministic gaps", defaultFocus: "First gap",
    primaryAction: "Recompute", actionBudget: 2, areaRole: "support", narrowBehavior: "stack",
    emptyState: "No open evidence gaps.",
  },
  "rho.claim-trace": {
    label: "Claim trace", primaryTask: "Inspect one exact claim trace", defaultFocus: "Claim",
    primaryAction: null, actionBudget: 2, areaRole: "context", narrowBehavior: "stack",
    emptyState: "Open an exact claim from Claims.",
  },
  "rho.file-preview": {
    label: "File preview", primaryTask: "Read a rendered project file", defaultFocus: "Document body",
    primaryAction: null, actionBudget: 2, areaRole: "primary", narrowBehavior: "retain",
    emptyState: "Choose a previewable file from Navigator.",
  },
  "rho.file-source": {
    label: "Source editor", primaryTask: "Edit and run project source", defaultFocus: "Editor",
    primaryAction: "Run", actionBudget: 3, areaRole: "primary", narrowBehavior: "retain",
    emptyState: "Choose a source file from Navigator.",
  },
  "rho.git": {
    label: "Git", primaryTask: "Review working-tree changes", defaultFocus: "Changed files",
    primaryAction: "Refresh", actionBudget: 2, areaRole: "support", narrowBehavior: "stack",
    emptyState: "No repository changes are visible.",
  },
  "rho.help": {
    label: "Help", primaryTask: "Find command and workflow guidance", defaultFocus: "Search",
    primaryAction: "Search", actionBudget: 2, areaRole: "support", narrowBehavior: "stack",
    emptyState: "Search for a command, component, or workflow.",
  },
  "rho.logs": {
    label: "Logs", primaryTask: "Inspect operational diagnostics", defaultFocus: "Newest log",
    primaryAction: "Open diagnostics", actionBudget: 1, areaRole: "strip", narrowBehavior: "strip",
    emptyState: "No operational messages.",
  },
  "rho.navigator": {
    label: "Navigator", primaryTask: "Find project files and execution history", defaultFocus: "Files",
    primaryAction: "Open", actionBudget: 2, areaRole: "support", narrowBehavior: "retain",
    emptyState: "Project files appear after discovery.",
  },
  "rho.plots": {
    label: "Plots", primaryTask: "Inspect generated plots", defaultFocus: "Newest plot",
    primaryAction: "Open", actionBudget: 2, areaRole: "support", narrowBehavior: "stack",
    emptyState: "Plots created by R will appear here.",
  },
  "rho.problems": {
    label: "Problems", primaryTask: "Resolve project diagnostics", defaultFocus: "First problem",
    primaryAction: "Open source", actionBudget: 1, areaRole: "strip", narrowBehavior: "strip",
    emptyState: "No project problems.",
  },
  "rho.jobs": {
    label: "Jobs", primaryTask: "Track submitted and render jobs", defaultFocus: "Active job",
    primaryAction: "Refresh", actionBudget: 2, areaRole: "support", narrowBehavior: "stack",
    emptyState: "Jobs will appear when work is submitted.",
  },
  "rho.artifacts": {
    label: "Artifacts", primaryTask: "Inspect durable artifact identity", defaultFocus: "Newest artifact",
    primaryAction: "Refresh", actionBudget: 2, areaRole: "support", narrowBehavior: "stack",
    emptyState: "Durable artifacts will appear here.",
  },
  "rho.approvals": {
    label: "Approvals", primaryTask: "Review broker-owned approval receipts", defaultFocus: "Newest approval",
    primaryAction: "Refresh", actionBudget: 2, areaRole: "context", narrowBehavior: "stack",
    emptyState: "Approval receipts will appear here.",
  },
  "rho.revisions": {
    label: "Revisions", primaryTask: "Inspect current authority revisions", defaultFocus: "Project revision",
    primaryAction: "Refresh", actionBudget: 2, areaRole: "context", narrowBehavior: "stack",
    emptyState: "Revision state is unavailable.",
  },
  "rho.runs": {
    label: "History", primaryTask: "Review and repeat scientific executions", defaultFocus: "Newest execution",
    primaryAction: "Run again", actionBudget: 2, areaRole: "support", narrowBehavior: "stack",
    emptyState: "Executed code will appear here.",
  },
  "rho.settings": {
    label: "Settings", primaryTask: "Configure trusted application capabilities", defaultFocus: "Settings modules",
    primaryAction: null, actionBudget: 2, areaRole: "context", narrowBehavior: "retain",
    emptyState: "Choose a Settings module.",
  },
  "rho.status": {
    label: "Runtime status", primaryTask: "Monitor scientific Runtime health", defaultFocus: "Status summary",
    primaryAction: null, actionBudget: 1, areaRole: "strip", narrowBehavior: "strip",
    emptyState: "Runtime status is unavailable.",
  },
  "rho.surface-playground": {
    label: "Component playground", primaryTask: "Preview component contracts", defaultFocus: "Preview controls",
    primaryAction: "Open preview", actionBudget: 2, areaRole: "developer", narrowBehavior: "collapse",
    emptyState: "Open a component preview from Compose.",
  },
};

export function humanizeSurfaceId(surfaceId: string): string {
  const segment = surfaceId.split(".").filter(Boolean).at(-1) ?? surfaceId;
  const words = segment.replaceAll(/[-_]+/gu, " ").trim();
  return words === "" ? "Component" : words[0]!.toLocaleUpperCase() + words.slice(1);
}

export function surfaceCatalogPolicy(surfaceId: string): SurfaceCatalogPolicy {
  return FIRST_PARTY_SURFACE_CATALOG[surfaceId] ?? (surfaceId.startsWith("rho.")
    ? {
        visibility: "internal", capabilityGroup: "workbench", flowStage: "project",
        composeOrder: 900, handoffTargets: [],
      }
    : {
        visibility: "primary", capabilityGroup: "project_extension", flowStage: "project",
        composeOrder: 900, handoffTargets: [],
      });
}

export function compareSurfaceCatalogOrder(leftSurfaceId: string, rightSurfaceId: string): number {
  const left = surfaceCatalogPolicy(leftSurfaceId);
  const right = surfaceCatalogPolicy(rightSurfaceId);
  return left.composeOrder - right.composeOrder || leftSurfaceId.localeCompare(rightSurfaceId);
}

export function surfaceDisplayLabel(surfaceId: string): string {
  return FIRST_PARTY_SURFACE_UX[surfaceId]?.label ?? humanizeSurfaceId(surfaceId);
}

export function surfaceUxProfile(surfaceId: string): SurfaceUxProfile {
  return FIRST_PARTY_SURFACE_UX[surfaceId] ?? {
    label: humanizeSurfaceId(surfaceId),
    primaryTask: "Use this project component",
    defaultFocus: "First interactive control",
    primaryAction: null,
    actionBudget: 2,
    areaRole: "context",
    narrowBehavior: "collapse",
    emptyState: "This project component has no content yet.",
  };
}
