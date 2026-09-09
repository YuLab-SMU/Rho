import type { ObjectMetadata } from "./generated/ObjectMetadata";
import type { ObjectScalar } from "./generated/ObjectScalar";
export const numberLabel = (n: number) => n.toLocaleString("en-US");
export const objectType = (m: ObjectMetadata | null) =>
  !m
    ? "Unknown"
    : m.kind !== "value"
      ? m.kind.replaceAll("_", " ")
      : (m.classes[0] ??
        (m.dimensions.length > 2
          ? "array"
          : m.dimensions.length === 2
            ? "matrix"
            : m.object_type === "closure"
              ? "function"
              : (m.object_type ?? "Unknown")));
export const attribute = (m: ObjectMetadata | null, name: string) =>
  m?.attributes.find((a) => a.name === name)?.values ?? [];
export function objectSize(m: ObjectMetadata | null): string {
  if (!m || m.kind !== "value") return "Not evaluated";
  if (m.dimensions.length === 2)
    return `${numberLabel(m.dimensions[0])} rows × ${numberLabel(m.dimensions[1])} columns`;
  if (m.dimensions.length)
    return m.dimensions.map(numberLabel).join(" × ") + " dimensions";
  if (m.object_type === "NULL") return "NULL";
  if (m.length === null) return "Metadata";
  if (m.classes.includes("factor"))
    return `${numberLabel(m.length)} values${m.level_count != null ? ` · ${m.level_count} levels` : ""}`;
  if (m.object_type === "closure") return `${m.length} arguments`;
  if (m.object_type === "character")
    return `${numberLabel(m.length)} strings${m.length === 1 && m.preview?.[0]?.text_characters != null ? ` · ${numberLabel(m.preview[0].text_characters)} characters` : ""}`;
  return `${numberLabel(m.length)} ${m.supported_reads.includes("children") ? "elements" : "values"}`;
}
export function scalarText(
  value: ObjectScalar | undefined,
  m: ObjectMetadata | null = null,
  raw = false,
): string {
  if (!value) return "Not previewed";
  if (value.kind === "factor" && !raw && value.label !== null)
    return value.label;
  if (value.label !== null && value.kind !== "factor") return value.label;
  if (value.text !== null)
    return (
      (raw ? value.text : JSON.stringify(value.text)) +
      (value.next_text_start ? "…" : "")
    );
  if (value.logical !== null) return value.logical ? "TRUE" : "FALSE";
  if (value.imaginary !== null)
    return `${value.number} ${value.imaginary < 0 ? "−" : "+"} ${Math.abs(value.imaginary)}i`;
  if (value.number === null) return "Not previewed";
  if (value.object_type === "raw")
    return value.number.toString(16).padStart(2, "0");
  if (!raw && m?.classes.includes("factor"))
    return attribute(m, "levels")[value.number - 1] ?? `[code ${value.number}]`;
  if (!raw && m?.classes.includes("Date")) {
    const date = new Date(value.number * 86400000);
    return Number.isFinite(date.getTime())
      ? date.toISOString().slice(0, 10)
      : String(value.number);
  }
  if (!raw && m?.classes.includes("POSIXct")) {
    const zone = attribute(m, "tzone").find(Boolean) ?? "UTC",
      date = new Date(value.number * 1000);
    try {
      return (
        new Intl.DateTimeFormat("sv-SE", {
          timeZone: zone,
          dateStyle: "short",
          timeStyle: "medium",
        }).format(date) + ` ${zone}`
      );
    } catch {
      return String(value.number);
    }
  }
  if (!raw && m?.classes.includes("difftime"))
    return `${value.number} ${attribute(m, "units").join(" ")}`;
  return String(value.number);
}
export function colorValue(v: ObjectScalar | undefined): string | null {
  if (v?.color) return v.color;
  const s = v?.text;
  return s && !v.next_text_start && /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)
    ? s
    : null;
}
export function objectExpression(
  name: string,
  indices: readonly { kind: string; index?: number; name?: string }[] = [],
) {
  const root = `get(${JSON.stringify(name)}, envir = .GlobalEnv, inherits = FALSE)`;
  return (
    root +
    indices
      .map((p) =>
        p.kind === "index" ? `[[${p.index}]]` : `[[${JSON.stringify(p.name)}]]`,
      )
      .join("")
  );
}
