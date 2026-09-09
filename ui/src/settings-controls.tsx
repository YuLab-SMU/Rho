import { useEffect, useRef, useState } from "react";
import { useSession, usePreferences } from "./context";
import { sameScope, message } from "./shared/ports";
import { Modal } from "./primitives";
import type { RProbe } from "./generated/RProbe";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  return <Modal title="Local R Settings" description="Use an installed R and Ark runtime." onClose={onClose}><SettingsControls /></Modal>;
}
export function SettingsControls({ section = "all" }: { section?: "all" | "editor" | "runtime" }) {
  const session = useSession(), preferences = usePreferences(),
    [selection, setSelection] = useState(
      session.r?.current?.selection ??
        session.r?.candidates[0] ?? { executable: "", ark: "" },
    );
  const [probe, setProbe] = useState<RProbe | null>(session.r?.current ?? null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const mounted = useRef(true), request = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current++; };
  }, []);
  function updateSelection(value: typeof selection) {
    request.current++; setBusy(false); setSelection(value); setProbe(null);
  }
  async function check() {
    const generation = ++request.current, scope = session.context();
    const current = () => mounted.current && generation === request.current && sameScope(scope, session.context());
    setBusy(true); setError("");
    try {
      const result = await session.probeR(selection);
      if (current()) setProbe(result);
    } catch (error) {
      if (current()) setError(message(error));
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function apply() {
    const generation = ++request.current, scope = session.context();
    const current = () => mounted.current && generation === request.current && session.project === scope.project && session.epoch >= scope.epoch && session.epoch <= scope.epoch + 1;
    setBusy(true); setError("");
    try {
      await session.applyR(selection, confirmed);
      if (current()) setError(session.r?.error ?? "");
    } catch (error) {
      if (current()) setError(message(error));
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function savePreferences(change: { editorFontSize?: number; indentWidth?: number }) {
    const scope = session.context();
    try { await preferences.setPreferences(change); }
    catch (error) { if (mounted.current && sameScope(scope, session.context())) setError(message(error)); }
  }
  return (
    <div className="settings-controls">
      {section !== "runtime" && <>
      <div className="preferences">
        <label>
          Code Font Size
          <select
            aria-label="Code Font Size"
            value={preferences.editorFontSize}
            onChange={(e) =>
              void savePreferences({ editorFontSize: Number(e.target.value) })
            }
          >
            {[12, 14, 16, 18].map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
        </label>
        <label>
          Indent Width
          <select
            aria-label="Indent Width"
            value={preferences.indentWidth}
            onChange={(e) =>
              void savePreferences({ indentWidth: Number(e.target.value) })
            }
          >
            {[2, 4, 8].map((size) => (
              <option key={size} value={size}>
                {size} spaces
              </option>
            ))}
          </select>
        </label>
      </div>
      </>}
      {section !== "editor" && <>
      {!!session.r?.candidates.length && (
        <label>
          Discovered R Installations
          <select
            value={selection.executable}
            onChange={(e) => {
              const next = session.r!.candidates.find(
                (c) => c.executable === e.target.value,
              );
              if (next) {
                updateSelection(next);
              }
            }}
          >
            {session.r.candidates.map((c) => (
              <option key={c.executable}>{c.executable}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        R Executable
        <input
          value={selection.executable}
          onChange={(e) => {
            updateSelection({ ...selection, executable: e.target.value });
          }}
        />
      </label>
      <label>
        Ark Executable
        <input
          value={selection.ark}
          onChange={(e) => {
            updateSelection({ ...selection, ark: e.target.value });
          }}
        />
      </label>
      <button disabled={busy} onClick={() => void check()}>
        Check Configuration
      </button>
      {probe && (
        <div className="probe">
          <p>
            R {probe.version ?? "Unknown"} · {probe.architecture ?? "Unknown"}
          </p>
          <p>{probe.r_home}</p>
          <p>
            jsonlite {probe.jsonlite ? "Available" : "Missing"} · rlang{" "}
            {probe.rlang ? "Available" : "Missing"} · Ark{" "}
            {probe.ark_available ? "Available" : "Missing"}
          </p>
          {probe.diagnostics.map((d, i) => (
            <p key={i}>{d}</p>
          ))}
        </div>
      )}
      {session.project && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          End the current R session and restart
        </label>
      )}
      <button
        className="primary"
        disabled={busy || !probe?.usable || (!!session.project && !confirmed)}
        onClick={() => void apply()}
      >
        Apply and Start R
      </button>
      </>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
