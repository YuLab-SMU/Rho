import type { ObjectMetadata } from "../public/r-protocol/index.js";
import type { ObjectScalar } from "../public/r-protocol/index.js";
import type { ObjectReadPage } from "../public/r-protocol/index.js";
import { colorValue } from "./object-values.js";
export type VectorCopyFormat = "r" | "hex-r" | "hex-lines";
export interface CollectedVector {
  values: ObjectScalar[];
  names?: ObjectScalar[];
  levels?: ObjectScalar[];
  metadata: ObjectMetadata;
  objectRef: string;
  start: number;
}
export const vectorCopyBytes = 1024 * 1024;
export const rString = (text: string) => JSON.stringify(text);
export function completePalette(
  metadata: ObjectMetadata,
  page?: ObjectReadPage,
) {
  return (
    metadata.object_type === "character" &&
    !!page &&
    page.start === 1 &&
    page.next_start === null &&
    page.values.length === metadata.length &&
    page.values.length > 0 &&
    page.values.every((v) => !!colorValue(v))
  );
}
function scalarLiteral(v: ObjectScalar, type: string): string {
  if (type === "complex" && (v.kind === "missing" || v.kind === "non_finite"))
    throw new Error("Exact non-finite complex components are unavailable.");
  if (v.kind === "missing")
    return (
      (
        {
          character: "NA_character_",
          integer: "NA_integer_",
          double: "NA_real_",
          complex: "NA_complex_",
          logical: "NA",
        } as Record<string, string>
      )[type] ?? "NA"
    );
  if (v.next_text_start != null && type === "character")
    throw new Error("A shortened string cannot be copied as a complete value.");
  if (type === "character") {
    if (v.text === null) throw new Error("Character value unavailable.");
    return rString(v.text);
  }
  if (type === "logical") {
    if (v.logical === null) throw new Error("Logical value unavailable.");
    return v.logical ? "TRUE" : "FALSE";
  }
  if (type === "complex") {
    if (v.kind === "non_finite" || v.number === null || v.imaginary === null)
      throw new Error("Exact non-finite complex components are unavailable.");
    return `complex(real = ${v.number}, imaginary = ${v.imaginary})`;
  }
  if (v.kind === "non_finite") {
    if (!["NA", "NaN", "Inf", "-Inf"].includes(v.label ?? ""))
      throw new Error("Numeric value unavailable.");
    return v.label!;
  }
  if (v.number === null) throw new Error("Numeric value unavailable.");
  return `${v.number}${type === "integer" ? "L" : ""}`;
}
function atomicVector(values: ObjectScalar[], type: string) {
  if (!values.length) return `${type === "double" ? "numeric" : type}(0)`;
  const expression = `c(${values.map((v) => scalarLiteral(v, type)).join(", ")})`;
  return type === "raw" ? `as.raw(${expression})` : expression;
}
export function serializeVector(
  data: CollectedVector,
  format: VectorCopyFormat = "r",
): string {
  const type = data.metadata.object_type ?? "character";
  let text: string;
  if (format === "r") {
    text = atomicVector(data.values, type);
    const attrs: string[] = [];
    if (data.names)
      attrs.push(`names = ${atomicVector(data.names, "character")}`);
    if (data.metadata.classes.includes("factor")) {
      if (!data.levels)
        throw new Error("Factor levels are required for an exact copy.");
      attrs.push(`levels = ${atomicVector(data.levels, "character")}`);
    }
    if (data.metadata.classes.length)
      attrs.push(`class = c(${data.metadata.classes.map(rString).join(", ")})`);
    for (const a of data.metadata.attributes.filter((a) =>
      ["units", "tzone"].includes(a.name),
    ))
      attrs.push(
        `${a.name} = ${a.values.length ? `c(${a.values.map(rString).join(", ")})` : "character(0)"}`,
      );
    if (attrs.length) text = `structure(${text}, ${attrs.join(", ")})`;
  } else {
    const values = data.values.map((v, i) => {
      if (v.kind === "missing")
        return format === "hex-lines" ? "NA" : "NA_character_";
      const color = colorValue(v);
      if (!color)
        throw new Error(
          `Value ${data.start + i} is not a complete R color. Use the original R vector format.`,
        );
      return format === "hex-lines" ? color : rString(color);
    });
    text =
      format === "hex-lines"
        ? values.join("\n")
        : values.length
          ? `c(${values.join(", ")})`
          : "character(0)";
    if (format === "hex-r" && data.names)
      text = `structure(${text}, names = ${atomicVector(data.names, "character")})`;
  }
  if (new TextEncoder().encode(text).length > vectorCopyBytes)
    throw new Error("Copy exceeds 1 MiB. Select a smaller range.");
  return text;
}
