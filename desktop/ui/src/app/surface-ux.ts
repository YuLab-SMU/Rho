export type SurfaceAreaRole = "primary" | "support" | "context" | "strip" | "developer";
export type SurfaceCatalogVisibility = "primary" | "contextual" | "internal" | "developer";
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
}

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
  "rho.agent": { visibility: "primary", capabilityGroup: "agent" },
  "rho.check-result": { visibility: "contextual", capabilityGroup: "results" },
  "rho.console": { visibility: "primary", capabilityGroup: "workspace_r" },
  "rho.environment": { visibility: "primary", capabilityGroup: "workspace_r" },
  "rho.evidence": { visibility: "contextual", capabilityGroup: "results" },
  "rho.file-preview": { visibility: "contextual", capabilityGroup: "workbench" },
  "rho.file-source": { visibility: "primary", capabilityGroup: "workbench" },
  "rho.git": { visibility: "primary", capabilityGroup: "project_integration" },
  "rho.help": { visibility: "contextual", capabilityGroup: "workbench" },
  "rho.logs": { visibility: "contextual", capabilityGroup: "results" },
  "rho.navigator": { visibility: "primary", capabilityGroup: "workbench" },
  "rho.plots": { visibility: "primary", capabilityGroup: "results" },
  "rho.problems": { visibility: "primary", capabilityGroup: "results" },
  "rho.render-jobs": { visibility: "contextual", capabilityGroup: "results" },
  "rho.runs": { visibility: "primary", capabilityGroup: "results" },
  "rho.settings": { visibility: "internal", capabilityGroup: "workbench" },
  "rho.status": { visibility: "internal", capabilityGroup: "workspace_r" },
  "rho.surface-playground": { visibility: "developer", capabilityGroup: "developer" },
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
    label: "Environment", primaryTask: "Inspect project packages and operations", defaultFocus: "Package list",
    primaryAction: "Refresh", actionBudget: 2, areaRole: "context", narrowBehavior: "collapse",
    emptyState: "Package state appears after inspection.",
  },
  "rho.evidence": {
    label: "Evidence", primaryTask: "Inspect supporting evidence", defaultFocus: "First evidence item",
    primaryAction: "Open", actionBudget: 2, areaRole: "support", narrowBehavior: "stack",
    emptyState: "Evidence linked by checks and runs will appear here.",
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
  "rho.render-jobs": {
    label: "Render jobs", primaryTask: "Track document rendering", defaultFocus: "Active job",
    primaryAction: "Open output", actionBudget: 2, areaRole: "support", narrowBehavior: "stack",
    emptyState: "Render jobs will appear when documents are built.",
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
    ? { visibility: "internal", capabilityGroup: "workbench" }
    : { visibility: "primary", capabilityGroup: "project_extension" });
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
