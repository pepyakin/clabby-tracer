export interface CanvasBackingStore {
  width: number
  height: number
  scaleX: number
  scaleY: number
}

export interface CanvasRowTile {
  startRow: number
  rowCount: number
}

export function nativeCanvasSize(cssWidth: number, cssHeight: number, devicePixelRatio: number) {
  return {
    width: Math.max(1, Math.round(cssWidth * devicePixelRatio)),
    height: Math.max(1, Math.round(cssHeight * devicePixelRatio)),
  }
}

export function splitCanvasRows(
  rowCount: number,
  rowHeight: number,
  devicePixelRatio: number,
  maxPixels: number,
): CanvasRowTile[] {
  const rowsPerTile = Math.max(1, Math.floor(maxPixels / devicePixelRatio / rowHeight))
  const tiles: CanvasRowTile[] = []
  for (let startRow = 0; startRow < rowCount; startRow += rowsPerTile) {
    tiles.push({ startRow, rowCount: Math.min(rowsPerTile, rowCount - startRow) })
  }
  return tiles
}

function fitAxis(cssPixels: number, devicePixelRatio: number, maxPixels: number) {
  const pixels = Math.min(maxPixels, Math.max(1, Math.round(cssPixels * devicePixelRatio)))
  return { pixels, scale: pixels / cssPixels }
}

/**
 * Fit a canvas backing store within the browser's per-axis pixel limit without
 * changing its logical CSS size. Oversized axes render at a lower pixel density
 * so content remains visible instead of being clipped.
 */
export function fitCanvasBackingStore(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels: number,
): CanvasBackingStore {
  const x = fitAxis(cssWidth, devicePixelRatio, maxPixels)
  const y = fitAxis(cssHeight, devicePixelRatio, maxPixels)
  return { width: x.pixels, height: y.pixels, scaleX: x.scale, scaleY: y.scale }
}
