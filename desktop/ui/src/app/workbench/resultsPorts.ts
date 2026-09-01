import type { HistoryReadTransport } from "../../transport/history";

export type ResultsPorts = Pick<
  HistoryReadTransport,
  "listPlotArtifacts" | "readPlotArtifact" | "listProblems"
>;

const cache = new WeakMap<object, ResultsPorts>();

export function createResultsPorts(source: HistoryReadTransport): ResultsPorts {
  const cached = cache.get(source as object);
  if (cached != null) return cached;
  const ports: ResultsPorts = {
    listPlotArtifacts: (limit, sessionOnly) => source.listPlotArtifacts(limit, sessionOnly),
    readPlotArtifact: (plotId) => source.readPlotArtifact(plotId),
    listProblems: (limit) => source.listProblems(limit),
  };
  cache.set(source as object, ports);
  return ports;
}
