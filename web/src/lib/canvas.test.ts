import { describe, expect, test } from 'bun:test'
import { fitCanvasBackingStore } from './canvas'

describe('fitCanvasBackingStore', () => {
  test('keeps every logical row when the canvas is taller than the browser limit', () => {
    const fitted = fitCanvasBackingStore(1200, 50_000, 2, 16_384)

    expect(fitted.width).toBe(2400)
    expect(fitted.height).toBe(16_384)
    expect(fitted.scaleX).toBe(2)
    expect(fitted.scaleY).toBeCloseTo(16_384 / 50_000)
  })
})
