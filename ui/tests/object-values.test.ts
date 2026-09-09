import { expect, it } from "vitest";
import { colorValue, scalarText } from "../src/object-values";
import type { ObjectScalar } from "../src/generated/ObjectScalar";
const value = (patch: Partial<ObjectScalar>): ObjectScalar => ({
  kind: "value",
  object_type: "double",
  logical: null,
  number: null,
  imaginary: null,
  text: null,
  label: null,
  text_characters: null,
  next_text_start: null,
  ...patch,
});
it("distinguishes missing, literal NA, empty text, complex and raw values", () => {
  expect(scalarText(value({ kind: "missing", label: "NA" }))).toBe("NA");
  expect(scalarText(value({ object_type: "character", text: "NA" }))).toBe(
    '"NA"',
  );
  expect(scalarText(value({ object_type: "character", text: "" }))).toBe('""');
  expect(
    scalarText(value({ object_type: "complex", number: 1, imaginary: -2 })),
  ).toBe("1 − 2i");
  expect(scalarText(value({ object_type: "raw", number: 255 }))).toBe("ff");
});
it("uses canonical R colors and retains factor codes separately from displayed labels", () => {
  expect(
    colorValue(
      value({ object_type: "character", text: "green", color: "#00FF00FF" }),
    ),
  ).toBe("#00FF00FF");
  expect(
    colorValue(value({ object_type: "character", text: "green" })),
  ).toBeNull();
  const v = value({
    kind: "factor",
    object_type: "integer",
    number: 10,
    label: "Recovery",
  });
  expect(scalarText(v)).toBe("Recovery");
  expect(scalarText(v, null, true)).toBe("10");
});
