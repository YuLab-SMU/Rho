// A cell another page asks the Notebook to open at, such as one the Overview lists. The next
// Notebook page that holds it takes it once and scrolls there instead of to the newest cell.
let asked: string | null = null;
export const askCell = (cellId: string) => { asked = cellId; };
export function takeCell(has: (cellId: string) => boolean) {
  if (!asked || !has(asked)) return null;
  const cellId = asked; asked = null;
  return cellId;
}
