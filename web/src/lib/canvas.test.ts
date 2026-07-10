import { describe, expect, test } from 'bun:test'
import { fitCanvasBackingStore, nativeCanvasSize, splitCanvasRows } from './canvas'

describe('fitCanvasBackingStore', () => {
  test('keeps every logical row when the canvas is taller than the browser limit', () => {
    const fitted = fitCanvasBackingStore(1200, 50_000, 2, 16_384)

    expect(fitted.width).toBe(2400)
    expect(fitted.height).toBe(16_384)
    expect(fitted.scaleX).toBe(2)
    expect(fitted.scaleY).toBeCloseTo(16_384 / 50_000)
  })
})

describe('nativeCanvasSize', () => {
  test('keeps full device-pixel density', () => {
    expect(nativeCanvasSize(1200, 660, 2)).toEqual({ width: 2400, height: 1320 })
  })
})

describe('splitCanvasRows', () => {
  test('splits deep lanes at row boundaries without scaling', () => {
    expect(splitCanvasRows(900, 20, 2, 16_384)).toEqual([
      { startRow: 0, rowCount: 409 },
      { startRow: 409, rowCount: 409 },
      { startRow: 818, rowCount: 82 },
    ])
  })

  test('reserves the final lane gap without exceeding the backing-store limit', () => {
    const tiles = splitCanvasRows(409, 20, 2, 16_384, 1)

    expect(tiles).toEqual([
      { startRow: 0, rowCount: 408 },
      { startRow: 408, rowCount: 1 },
    ])
    expect(tiles.reduce((rows, tile) => rows + tile.rowCount, 0)).toBe(409)
    const last = tiles[tiles.length - 1]
    expect(nativeCanvasSize(1200, (last.rowCount + 1) * 20, 2).height).toBeLessThanOrEqual(16_384)
  })
})
