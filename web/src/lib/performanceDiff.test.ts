import { describe, expect, test } from 'bun:test'
import type { Instance, SpanNode, TraceModel } from './model'
import { adjustPValues, analyzePerformanceDiff } from './performanceDiff'

function span(id: string, instanceId: string, name: string, durationNs: number, children: SpanNode[] = []): SpanNode {
  return {
    spanId: id,
    parentSpanId: null,
    traceId: id,
    name,
    kind: 'internal',
    startNs: 0,
    durationNs,
    attributes: {},
    events: [],
    status: 'unset',
    statusMessage: '',
    level: null,
    instanceId,
    children,
    depth: 0,
  }
}

function model(scale: number, operations = 12, extra = false): TraceModel {
  const spans = new Map<string, SpanNode>()
  const instances: Instance[] = ['node-0', 'node-1'].map((instanceId) => {
    const roots: SpanNode[] = []
    for (let i = 0; i < operations / 2; i++) {
      const child = span(`${instanceId}-${i}-child`, instanceId, 'work', (1_000 + i) * scale)
      child.depth = 1
      child.parentSpanId = `${instanceId}-${i}-root`
      const children = extra ? [child, span(`${instanceId}-${i}-extra`, instanceId, 'extra', 500 * scale)] : [child]
      children.forEach((item) => {
        item.depth = 1
        item.parentSpanId = `${instanceId}-${i}-root`
        spans.set(item.spanId, item)
      })
      const root = span(`${instanceId}-${i}-root`, instanceId, 'round', 2_000 * scale, children)
      spans.set(root.spanId, root)
      roots.push(root)
    }
    return {
      id: instanceId,
      serviceName: instanceId,
      instanceTag: null,
      colorIndex: 0,
      spanCount: roots.length * 2,
      rootSpans: roots,
      maxDepth: 1,
    }
  })
  return { traceId: String(scale), startUnixMs: 0, durationNs: 1, instances, spans, events: [], warnings: [] }
}

function wideModel(scale: number): TraceModel {
  const instances: Instance[] = []
  const spans = new Map<string, SpanNode>()
  for (let node = 0; node < 4; node++) {
    const instanceId = `node-${node}`
    const rootSpans: SpanNode[] = []
    for (let operation = 0; operation < 13; operation++) {
      const rootId = `${instanceId}-${operation}`
      const children = Array.from({ length: 150 }, (_, path) => {
        const child = span(`${rootId}-${path}`, instanceId, `phase-${path}`, (path + operation + 1) * scale)
        child.parentSpanId = rootId
        child.depth = 1
        spans.set(child.spanId, child)
        return child
      })
      const root = span(rootId, instanceId, 'round', 20_000 * scale, children)
      spans.set(root.spanId, root)
      rootSpans.push(root)
    }
    instances.push({
      id: instanceId,
      serviceName: instanceId,
      instanceTag: null,
      colorIndex: 0,
      spanCount: rootSpans.length * 151,
      rootSpans,
      maxDepth: 1,
    })
  }
  return { traceId: String(scale), startUnixMs: 0, durationNs: 1, instances, spans, events: [], warnings: [] }
}

describe('analyzePerformanceDiff', () => {
  test('detects a deterministic regression and keeps full paths distinct', () => {
    const diff = analyzePerformanceDiff(model(1), model(2, 12, true), 0.02, { resamples: 200, seed: 7 })
    expect(diff.inferential).toBe(true)
    expect(diff.root?.relativeChange).toBe(1)
    expect(diff.paths.find((row) => row.path.join('/') === 'round/work')?.evidence).toBe('regressed')
    expect(diff.paths.find((row) => row.path.join('/') === 'round/extra')?.evidence).toBe('added')
  })

  test('falls back to descriptive output for sparse comparisons', () => {
    const diff = analyzePerformanceDiff(model(1, 4), model(2, 4), 0.02, { resamples: 20 })
    expect(diff.inferential).toBe(false)
    expect(diff.root?.evidence).toBe('descriptive')
    expect(diff.warning).toContain('At least 10')
  })

  test('falls back when node sets differ', () => {
    const candidate = model(2)
    candidate.instances[1].id = 'node-2'
    const diff = analyzePerformanceDiff(model(1), candidate, 0.02, { resamples: 20 })
    expect(diff.inferential).toBe(false)
    expect(diff.warning).toContain('Node sets differ')
  })

  test('adjusts p-values monotonically in original order', () => {
    expect(adjustPValues([0.01, 0.04, 0.03, null])).toEqual([0.03, 0.04, 0.04, null])
  })

  test('reuses resampling work across a realistic wide trace', () => {
    const started = performance.now()
    const diff = analyzePerformanceDiff(wideModel(1), wideModel(1.1), 0.02, {
      resamples: 300,
      seed: 9,
    })
    const elapsedMs = performance.now() - started
    expect(diff.paths).toHaveLength(151)
    expect(elapsedMs).toBeLessThan(150)
  })
})
