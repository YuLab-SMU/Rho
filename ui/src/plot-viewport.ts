export interface PlotTransform {
  zoom: number | null;
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export function fitScale(image: Size, canvas: Size) {
  return Math.min(
    Math.max(1, canvas.width - 32) / image.width,
    Math.max(1, canvas.height - 32) / image.height,
  );
}
export function constrain(
  p: PlotTransform,
  image: Size,
  canvas: Size,
): PlotTransform {
  if (p.zoom === null) return { ...p, x: 0, y: 0 };
  const limitX = Math.max(0, (image.width * p.zoom - canvas.width) / 2 + 16),
    limitY = Math.max(0, (image.height * p.zoom - canvas.height) / 2 + 16);
  return {
    ...p,
    x: Math.max(-limitX, Math.min(limitX, p.x)),
    y: Math.max(-limitY, Math.min(limitY, p.y)),
  };
}
export function zoomAt(
  p: PlotTransform,
  scale: number,
  point: { x: number; y: number },
  image: Size,
  canvas: Size,
): PlotTransform {
  const old = p.zoom ?? fitScale(image, canvas),
    zoom = Math.max(0.01, Math.min(8, scale)),
    ratio = zoom / old;
  return constrain(
    {
      zoom,
      x: point.x - (point.x - p.x) * ratio,
      y: point.y - (point.y - p.y) * ratio,
    },
    image,
    canvas,
  );
}
export interface PlotView {
  selected: string | null;
  follow: boolean;
  history: boolean;
  transforms: Record<string, PlotTransform>;
  seen: number;
  pinned?: boolean;
}
export const newPlotView = (): PlotView => ({
  selected: null,
  follow: true,
  history: true,
  transforms: {},
  seen: 0,
});
