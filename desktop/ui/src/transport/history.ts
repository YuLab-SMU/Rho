import {
  createHistoryCommands,
  type ArtifactRecordSummary as ArtifactRecordSummaryWire,
  type HistoryInvoke,
  type PlotArtifactSummary as PlotArtifactSummaryWire,
  type PlotImageView as PlotImageViewWire,
  type ProblemSummary as ProblemSummaryWire,
  type RunSummary as RunSummaryWire,
} from "./generated/history";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type RunSummary = DeepReadonly<RunSummaryWire>;
export type ProblemSummary = DeepReadonly<ProblemSummaryWire>;
export type ArtifactRecordSummary = DeepReadonly<ArtifactRecordSummaryWire>;
export type PlotArtifactSummary = DeepReadonly<PlotArtifactSummaryWire>;
export type PlotImageView = DeepReadonly<PlotImageViewWire>;

export interface HistoryReadTransport {
  listRuns(limit?: number): Promise<readonly RunSummary[]>;
  listArtifactRecords(
    limit?: number,
    sessionOnly?: boolean,
  ): Promise<readonly ArtifactRecordSummary[]>;
  listProblems(limit?: number): Promise<readonly ProblemSummary[]>;
  listPlotArtifacts(
    limit?: number,
    sessionOnly?: boolean,
  ): Promise<readonly PlotArtifactSummary[]>;
  readPlotArtifact(plotId: string): Promise<PlotImageView>;
}

export function createTauriHistoryReadTransport(invoke: HistoryInvoke): HistoryReadTransport {
  const commands = createHistoryCommands(invoke);
  return {
    listRuns: (limit = 100) => commands.listRuns(limit),
    listArtifactRecords: (limit = 100, sessionOnly = false) =>
      commands.listArtifactRecords(limit, sessionOnly),
    listProblems: (limit = 100) => commands.listProblems(limit),
    listPlotArtifacts: (limit = 100, sessionOnly = true) =>
      commands.listPlotArtifacts(limit, sessionOnly),
    readPlotArtifact: commands.readPlotArtifact,
  };
}
