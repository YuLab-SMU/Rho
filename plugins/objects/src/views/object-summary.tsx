import type { ObjectMetadata } from "../../public/r-protocol/index.js";
import type { ObjectScalar } from "../../public/r-protocol/index.js";
import {
  attribute,
  colorValue,
  functionSignature,
  numberLabel,
  objectSize,
  scalarText,
} from "../object-values";
import { ScalarValue } from "./object-common";
export function ObjectSummary({
  metadata: m,
  values,
  showSize = false,
}: {
  metadata: ObjectMetadata | null;
  values: readonly ObjectScalar[];
  showSize?: boolean;
}) {
  if (!m) return null;
  const names = attribute(m, "names"),
    sample =
      names.join(", ") +
      (m.length !== null && m.length > names.length && names.length ? "…" : "");
  if (m.kind !== "value") return <span className="muted">Not evaluated</span>;
  if (m.dimensions.length)
    return (
      <>
        <strong className="object-summary-primary">
          {!showSize && objectSize(m)}
        </strong>
        {sample && <span className="object-summary-secondary">{sample}</span>}
      </>
    );
  if (m.object_type === "closure" && values[0]?.text)
    return (
      <code className="object-signature" title={values[0].text}>
        {functionSignature(values[0].text)}
      </code>
    );
  if (
    m.supported_reads.includes("text") &&
    !m.supported_reads.includes("values") &&
    values[0]?.text
  )
    return (
      <code className="object-signature">{values[0].text.split("\n")[0]}</code>
    );
  if (m.classes.includes("factor"))
    return (
      <>
        {!showSize && (
          <strong className="object-summary-primary">{objectSize(m)}</strong>
        )}
        <span className="object-summary-secondary">
          {attribute(m, "levels").join(" · ")}
        </span>
      </>
    );
  if (
    m.object_type === "character" &&
    values.length > 1 &&
    values.every((v) => colorValue(v))
  ) {
    const all =
      m.length === values.length && values.every((v) => !v.next_text_start);
    return (
      <>
        {!showSize && !all && (
          <strong className="object-summary-primary">{objectSize(m)}</strong>
        )}
        <span className="object-color-sample">
          {values.map((v, i) => (
            <span
              className="object-swatch"
              key={i}
              style={{ backgroundColor: colorValue(v)! }}
              title={v.text!}
              aria-label={`Color ${v.text}`}
            />
          ))}
        </span>
        {!showSize && (
          <small className="object-summary-secondary object-summary-measure">
            {all
              ? `${numberLabel(values.length)} colors`
              : `${values.length} shown`}
          </small>
        )}
      </>
    );
  }
  if (m.length === 1 && values[0])
    return (
      <>
        <ScalarValue value={values[0]} metadata={m} />
        {!showSize && values[0].text_characters != null && (
          <small className="object-summary-secondary object-summary-measure">
            {numberLabel(values[0].text_characters)} chars
          </small>
        )}
      </>
    );
  if (m.length === 0)
    return (
      <code>{m.object_type === "NULL" ? "NULL" : `${m.object_type}(0)`}</code>
    );
  if (m.supported_reads.includes("children"))
    return (
      <>
        {!showSize && (
          <strong className="object-summary-primary">{objectSize(m)}</strong>
        )}
        <span className="object-summary-secondary">{sample}</span>
      </>
    );
  if (values.length)
    return (
      <>
        {!showSize && (
          <strong className="object-summary-primary">{objectSize(m)}</strong>
        )}
        <span className="object-summary-secondary object-summary-values">
          {values
            .slice(0, 4)
            .map((v) => scalarText(v, m))
            .join(", ")}
          {(m.length ?? 0) > 4 ? " …" : ""}
        </span>
      </>
    );
  return (
    <span className="muted">
      {m.classes.some((c) => /ggplot/.test(c))
        ? "Plot object"
        : "Metadata only"}
    </span>
  );
}
