import { useEffect, useState } from "react";
import { useObjects } from "../context";
import type { ObjectMetadata } from "../generated/ObjectMetadata";
import type { ObjectReadPage } from "../generated/ObjectReadPage";
import type { ObjectPathElement } from "../generated/ObjectPathElement";
import type { ObjectScalar } from "../generated/ObjectScalar";
import type { ObjectPageRequest } from "../objects";
import { colorValue, scalarText } from "../object-values";
export function useObjectView<T>(
  key: string,
  initial: T,
): [T, (next: T) => void] {
  const o = useObjects();
  return [o.viewValue(key, initial), (next) => o.setViewValue(key, next)];
}
export function usePage(
  name: string,
  options: ObjectPageRequest,
  inline: boolean,
  enabled = true,
) {
  const o = useObjects(),
    observation = o.inspectors.get(name),
    key = JSON.stringify(options);
  const [result, setResult] = useState<{
    key: string;
    page?: ObjectReadPage;
    error?: string;
    loading: boolean;
  }>({ key, loading: true });
  const reference = observation?.page?.object_ref;
  useEffect(() => {
    let current = true;
    if (!enabled || !reference || observation?.stale) return;
    if (
      inline &&
      !options.path?.length &&
      options.kind === observation?.page?.kind &&
      (options.start ?? 1) === 1
    ) {
      setResult({ key, page: observation.page, loading: false });
      return;
    }
    setResult((previous) => ({
      key,
      page: previous.key === key ? previous.page : undefined,
      loading: true,
    }));
    o.readPage(name, JSON.parse(key)).then(
      (page) => {
        if (current) setResult({ key, page, loading: false });
      },
      (error) => {
        if (current)
          setResult((previous) => ({
            ...previous,
            loading: false,
            error: String(error.message ?? error),
          }));
      },
    );
    return () => {
      current = false;
    };
  }, [o, name, reference, key, observation?.stale, inline, enabled]);
  return reference &&
    result.key === key &&
    (!result.page || result.page.object_ref === reference)
    ? result
    : { key, loading: true };
}
export function ScalarValue({
  value,
  metadata,
  raw = false,
}: {
  value?: ObjectScalar;
  metadata?: ObjectMetadata | null;
  raw?: boolean;
}) {
  const color = colorValue(value);
  return (
    <span
      className={`object-scalar ${value?.kind === "missing" ? "is-missing" : ""}`}
    >
      {color && (
        <span
          className="object-swatch"
          style={{ backgroundColor: color }}
          aria-label={`Color ${color}`}
        />
      )}
      <span>{scalarText(value, metadata, raw)}</span>
    </span>
  );
}
export function TextDetail({
  name,
  path,
  index,
  value,
  baseKey,
  textAttribute,
}: {
  name: string;
  path: ObjectPathElement[];
  index: number;
  value?: ObjectScalar;
  baseKey: string;
  textAttribute?: "levels" | "names";
}) {
  const o = useObjects();
  const [raw, setRaw] = useObjectView(baseKey + ":escaped", false),
    [text, setText] = useState(value?.text ?? ""),
    [next, setNext] = useState(value?.next_text_start ?? null),
    [error, setError] = useState("");
  useEffect(() => {
    setText(value?.text ?? "");
    setNext(value?.next_text_start ?? null);
    setError("");
  }, [value, index]);
  return (
    <div className="object-text-detail">
      <div>
        <code>[[{index}]]</code>
        <div className="spacer" />
        <button aria-pressed={!raw} onClick={() => setRaw(false)}>
          Text
        </button>
        <button aria-pressed={raw} onClick={() => setRaw(true)}>
          Escaped
        </button>
        <button
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .catch(() => setError("Clipboard unavailable"));
          }}
        >
          Copy {next ? "loaded text" : "value"}
        </button>
      </div>
      <pre>{raw ? JSON.stringify(text) : text}</pre>
      <small>
        {value?.text_characters ?? 0} characters ·{" "}
        {new TextEncoder().encode(text).length} {next ? "loaded " : ""}UTF-8
        bytes · {text.split("\n").length} {next ? "loaded " : ""}lines
      </small>
      {next && (
        <button
          onClick={async () => {
            try {
              const p = await o.readPage(name, {
                kind: "text",
                path,
                text_attribute: textAttribute,
                start: index,
                text_start: next,
                text_limit_bytes: 16384,
              });
              setText((x) => x + (p.values[0]?.text ?? ""));
              setNext(p.next_text_start);
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          Load more text
        </button>
      )}
      {error && <p role="status">{error}</p>}
    </div>
  );
}
