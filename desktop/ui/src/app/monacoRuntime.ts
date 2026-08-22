import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/r/r.contribution.js";

interface MonacoEnvironmentHost {
  MonacoEnvironment?: {
    getWorker: () => Worker;
  };
}

(globalThis as typeof globalThis & MonacoEnvironmentHost).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export { monaco };
