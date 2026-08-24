export const PROJECT_HISTORY_KEY = "rho.project-history.v1";
export const MAX_PROJECT_HISTORY = 6;
const MAX_PROJECT_PATH_LENGTH = 4_096;
const MAX_PROJECT_HISTORY_PAYLOAD = 32_768;

export interface ProjectHistory {
  readonly version: 1;
  readonly paths: readonly string[];
}

export interface ProjectHistoryLoad {
  readonly history: ProjectHistory;
  readonly status: "default" | "clean" | "recovered" | "unavailable";
  readonly detail: string | null;
}

function emptyHistory(): ProjectHistory {
  return { version: 1, paths: [] };
}

function validProjectPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 &&
    path.length <= MAX_PROJECT_PATH_LENGTH &&
    ![...path].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
}

function recovered(detail: string): ProjectHistoryLoad {
  return { history: emptyHistory(), status: "recovered", detail };
}

export function loadProjectHistory(storage: Pick<Storage, "getItem">): ProjectHistoryLoad {
  let encoded: string | null;
  try {
    encoded = storage.getItem(PROJECT_HISTORY_KEY);
  } catch {
    return {
      history: emptyHistory(),
      status: "unavailable",
      detail: "Recent projects could not be read on this device.",
    };
  }
  if (encoded == null) return { history: emptyHistory(), status: "default", detail: null };
  if (encoded.length > MAX_PROJECT_HISTORY_PAYLOAD) {
    return recovered("Recent project history was oversized and has been reset.");
  }
  try {
    const candidate = JSON.parse(encoded) as { readonly version?: unknown; readonly paths?: unknown };
    if (candidate.version !== 1 || !Array.isArray(candidate.paths)) {
      return recovered("Recent project history used an unsupported format and has been reset.");
    }
    if (candidate.paths.length > MAX_PROJECT_HISTORY || !candidate.paths.every(validProjectPath)) {
      return recovered("Recent project history was invalid and has been reset.");
    }
    if (new Set(candidate.paths).size !== candidate.paths.length) {
      return recovered("Duplicate recent project paths were discarded.");
    }
    return {
      history: { version: 1, paths: candidate.paths },
      status: "clean",
      detail: null,
    };
  } catch {
    return recovered("Recent project history was malformed and has been reset.");
  }
}

export function rememberProjectPath(history: ProjectHistory, path: string): ProjectHistory {
  if (!validProjectPath(path)) return history;
  if (history.paths[0] === path) return history;
  return {
    version: 1,
    paths: [path, ...history.paths.filter((candidate) => candidate !== path)]
      .slice(0, MAX_PROJECT_HISTORY),
  };
}

export function saveProjectHistory(
  storage: Pick<Storage, "setItem">,
  history: ProjectHistory,
) {
  storage.setItem(PROJECT_HISTORY_KEY, JSON.stringify(history));
}
