import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseTrace } from '../lib/trace'
import FlameGraph, { keyboardNavigationSpeed, navigateFlameView } from './FlameGraph'

const extent = { t0: 10_000, t1: 110_000 }
const view = { t0: 30_000, t1: 70_000 }

describe('flame keyboard navigation', () => {
  test('makes the scrolling viewport, not its wrapper, the keyboard focus target', () => {
    const markup = renderToStaticMarkup(createElement(FlameGraph, {
      model: parseTrace({ resourceSpans: [] }, 'test'),
      mode: 'instances',
      selectedSpanId: null,
      hiddenInstances: new Set<string>(),
      onSelect: () => {},
      onSelectEvent: () => {},
      onToggleInstance: () => {},
      onToggleAll: () => {},
    }))
    expect(markup).toMatch(/^<div class="fg">/)
    expect(markup).toMatch(/<div class="fg-scroll"[^>]*tabindex="0"[^>]*role="region"/)
  })

  test('zooms around an off-center cursor, and reverses without drift', () => {
    const zoomed = navigateFlameView(view, extent, 0, -Math.log(2), 0.25, 1)
    expect(zoomed.t0).toBeCloseTo(35_000)
    expect(zoomed.t1).toBeCloseTo(55_000)
    const restored = navigateFlameView(zoomed, extent, 0, Math.log(2), 0.25, 1)
    expect(restored.t0).toBeCloseTo(view.t0)
    expect(restored.t1).toBeCloseTo(view.t1)
  })

  test('pans both ways relative to the visible window, preserving zoom at edges', () => {
    expect(navigateFlameView(view, extent, 0.1, 0, 0.5, 1)).toEqual({ t0: 34_000, t1: 74_000 })
    expect(navigateFlameView(view, extent, -0.1, 0, 0.5, 1)).toEqual({ t0: 26_000, t1: 66_000 })
    expect(navigateFlameView(view, extent, -10, 0, 0.5, 1)).toEqual({ t0: 10_000, t1: 50_000 })
    expect(navigateFlameView(view, extent, 10, 0, 0.5, 1)).toEqual({ t0: 70_000, t1: 110_000 })
  })

  test('clamps zoom at the cursor, including extents below the minimum window', () => {
    expect(navigateFlameView(view, extent, 0, -100, 0.25, 1)).toEqual({ t0: 39_750, t1: 40_750 })
    expect(navigateFlameView(view, extent, 0, 100, 0.25, 1)).toEqual(extent)
    const tiny = { t0: 70, t1: 90 }
    expect(navigateFlameView(tiny, tiny, 1, -100, 0.8, 1)).toEqual(tiny)
    expect(navigateFlameView(view, extent, 0, -Math.log(2), 0, 1).t0).toBe(view.t0)
    expect(navigateFlameView(view, extent, 0, -Math.log(2), 1, 1).t1).toBe(view.t1)
  })

  test('simultaneous pan and zoom is independent of frame subdivision', () => {
    // After one second: width halves; pan adds integral(0.1 * 40000 * 2^-t).
    const expectedStart = 35_000 + 2000 / Math.log(2)
    for (const fps of [30, 60, 144]) {
      let result = view
      for (let i = 0; i < fps; i++) {
        result = navigateFlameView(result, extent, 0.1, -Math.log(2), 0.25, 1 / fps)
      }
      expect(result.t0).toBeCloseTo(expectedStart, 6)
      expect(result.t1).toBeCloseTo(expectedStart + 20_000, 6)
    }
  })

  test('uses the selected immediate speeds and a capped linear 500ms ramp', () => {
    expect(keyboardNavigationSpeed(0, 'pan')).toBe(2)
    expect(keyboardNavigationSpeed(0.25, 'pan')).toBe(3)
    expect(keyboardNavigationSpeed(0.499, 'pan')).toBeCloseTo(3.996)
    expect(keyboardNavigationSpeed(0.5, 'pan')).toBe(4)
    expect(keyboardNavigationSpeed(30, 'pan')).toBe(4)
    expect(keyboardNavigationSpeed(0, 'zoom')).toBe(3)
    expect(keyboardNavigationSpeed(0.25, 'zoom')).toBe(4.125)
    expect(keyboardNavigationSpeed(0.5, 'zoom')).toBe(5.25)
    expect(keyboardNavigationSpeed(30, 'zoom')).toBe(5.25)
  })

  test('accelerated zoom tracks elapsed time at different refresh rates', () => {
    // Integral over 1s: (3+5.25)/2 * .5 + 5.25 * .5 = 4.6875 doublings.
    const expectedWidth = 40_000 * 2 ** -4.6875
    for (const fps of [30, 60, 144]) {
      let result = view
      for (let frame = 0; frame < fps; frame++) {
        const speed = keyboardNavigationSpeed((frame + 0.5) / fps, 'zoom')
        result = navigateFlameView(result, extent, 0, -Math.LN2 * speed, 0.25, 1 / fps)
      }
      expect(result.t1 - result.t0).toBeCloseTo(expectedWidth, 6)
    }
  })
})
