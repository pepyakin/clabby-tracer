import { describe, expect, test } from 'bun:test'
import type { PerformancePathDiff } from '../lib/model'
import { layoutFlame } from './PerformanceDiffPage'

function path(name: string[], meanNs: number): PerformancePathDiff {
  return {
    key: name.join('\u001f'),
    path: name,
    depth: name.length - 1,
    baseline: { meanNs },
    candidate: { meanNs },
    instances: [{ instanceId: 'node', baselineMeanNs: meanNs, candidateMeanNs: meanNs }],
  } as PerformancePathDiff
}

describe('layoutFlame', () => {
  test('fills each parent while preserving sibling cost proportions', () => {
    const layout = layoutFlame([
      path(['root'], 100),
      path(['root', 'large'], 60),
      path(['root', 'small'], 20),
      path(['root', 'large', 'nested'], 30),
    ], null)

    const cells = new Map(layout.cells.map((cell) => [cell.row.path.at(-1), cell]))

    expect(cells.get('root')?.width).toBe(100)
    expect(cells.get('large')?.width).toBe(75)
    expect(cells.get('small')?.width).toBe(25)
    expect(cells.get('nested')?.width).toBe(75)
    expect(cells.get('small')?.left).toBe(75)
  })

  test('contains concurrent children within their parent', () => {
    const layout = layoutFlame([
      path(['first'], 100),
      path(['first', 'concurrent-a'], 80),
      path(['first', 'concurrent-b'], 70),
      path(['second'], 100),
      path(['second', 'child'], 50),
    ], null)
    const cells = new Map(layout.cells.map((cell) => [cell.row.path.at(-1), cell]))
    const first = cells.get('first')!
    const firstChildren = [cells.get('concurrent-a')!, cells.get('concurrent-b')!]

    expect(firstChildren[0].left).toBeGreaterThanOrEqual(first.left)
    expect(firstChildren[1].left + firstChildren[1].width).toBeLessThanOrEqual(first.left + first.width)
    expect(firstChildren[0].width / firstChildren[1].width).toBeCloseTo(80 / 70)
  })

})

describe('flamegraph frame CSS', () => {
  test('includes padding and borders inside the proportional frame width', async () => {
    const css = await Bun.file(`${import.meta.dir}/PerformanceDiffPage.css`).text()
    const frameRule = /\.pd-frame\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''

    expect(frameRule).toContain('box-sizing: border-box')
  })
})
