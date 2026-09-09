export const fieldLabels = {
  content: "Content",
  size: "Size",
  type: "Type",
} as const;
export type ObjectField = keyof typeof fieldLabels;
export type WidthField = ObjectField | "name";
export interface ObjectFields {
  order: ObjectField[];
  hidden: ObjectField[];
  widths: Partial<Record<WidthField, number>>;
}
export const defaultFields = (): ObjectFields => ({
  order: ["content", "size", "type"],
  hidden: ["size"],
  widths: {},
});
export const widthLimits: Record<WidthField, [number, number]> = {
  name: [120, 420],
  content: [180, 1000],
  size: [100, 400],
  type: [80, 360],
};
const isField = (v: unknown): v is ObjectField =>
  typeof v === "string" && Object.hasOwn(fieldLabels, v);
export function normalizeFields(value: unknown): ObjectFields {
  const v = value as Partial<ObjectFields> | null;
  const order = Array.isArray(v?.order)
    ? [...new Set(v.order.filter(isField))]
    : [];
  for (const f of defaultFields().order) if (!order.includes(f)) order.push(f);
  const widths: ObjectFields["widths"] = {};
  for (const f of ["name", "content", "size", "type"] as const) {
    const n = v?.widths?.[f];
    if (typeof n === "number" && Number.isFinite(n))
      widths[f] = Math.round(
        Math.max(widthLimits[f][0], Math.min(widthLimits[f][1], n)),
      );
  }
  return {
    order,
    hidden: Array.isArray(v?.hidden)
      ? [...new Set(v.hidden.filter(isField))]
      : ["size"],
    widths,
  };
}
export function moveField(
  config: ObjectFields,
  from: ObjectField,
  to: ObjectField,
): ObjectFields {
  const order = [...config.order],
    a = order.indexOf(from),
    b = order.indexOf(to);
  if (a < 0 || b < 0 || a === b) return config;
  order.splice(a, 1);
  order.splice(b, 0, from);
  return { ...config, order };
}
export function fieldTemplate(config: ObjectFields) {
  return [
    `${config.widths.name ?? 180}px`,
    ...config.order
      .filter((f) => !config.hidden.includes(f))
      .map((f) =>
        config.widths[f]
          ? `${config.widths[f]}px`
          : f === "content"
            ? "minmax(180px, 1fr)"
            : f === "size"
              ? "220px"
              : "148px",
      ),
    "24px",
  ].join(" ");
}

export function fieldMinimumWidth(config: ObjectFields) {
  return (
    (config.widths.name ?? 180) +
    config.order
      .filter((f) => !config.hidden.includes(f))
      .reduce(
        (n, f) =>
          n +
          (config.widths[f] ??
            (f === "content" ? 180 : f === "size" ? 220 : 148)),
        0,
      ) +
    56
  );
}
