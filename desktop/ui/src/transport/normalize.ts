export function projectLabel(root: string): string {
  const pieces = root.replaceAll("\\", "/").split("/").filter(Boolean);
  return pieces.at(-1) ?? root;
}
