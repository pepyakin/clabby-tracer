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
    expect(diff.comparisonMode).toBe('paired')
    expect(diff.root?.relativeChange).toBe(1)
    expect(diff.root?.effectSize).toBeGreaterThan(0)
    expect(diff.paths.find((row) => row.path.join('/') === 'round/work')?.evidence).toBe('regressed')
    const added = diff.paths.find((row) => row.path.join('/') === 'round/extra')
    expect(added?.evidence).toBe('added')
    expect(added?.rawP).toBeNull()
  })

  test('computes estimates with a low-sample warning for sparse comparisons', () => {
    const diff = analyzePerformanceDiff(model(1, 4), model(2, 4), 0.02, { resamples: 20 })
    expect(diff.inferential).toBe(true)
    expect(diff.root?.relativeInterval).not.toBeNull()
    expect(diff.warning).toContain('Low sample size')
  })

  test('uses unpaired inference when node sets differ', () => {
    const candidate = model(2)
    candidate.instances[1].id = 'node-2'
    const diff = analyzePerformanceDiff(model(1), candidate, 0.02, { resamples: 20 })
    expect(diff.inferential).toBe(true)
    expect(diff.comparisonMode).toBe('unpaired')
    expect(diff.warning).toContain('unpaired')
    expect(diff.root?.relativeInterval).not.toBeNull()
  })

  test('supports inference for a single node with enough operations', () => {
    const baseline = model(1, 24)
    const candidate = model(2, 24)
    baseline.instances = baseline.instances.slice(0, 1)
    candidate.instances = candidate.instances.slice(0, 1)

    const diff = analyzePerformanceDiff(baseline, candidate, 0.02, { resamples: 100, seed: 11 })

    expect(diff.inferential).toBe(true)
    expect(diff.comparisonMode).toBe('paired')
    expect(diff.root?.relativeInterval).not.toBeNull()
  })

  test('includes asynchronous descendants in a path subtree cost', () => {
    const baseline = model(1)
    const candidate = model(1)
    for (const trace of [baseline, candidate]) {
      for (const instance of trace.instances) {
        for (const root of instance.rootSpans) {
          root.durationNs = 342_000
          root.children[0].startNs = 1_000_000
          root.children[0].durationNs = 70_000_000
        }
      }
    }

    const diff = analyzePerformanceDiff(baseline, candidate, 0.02, { resamples: 20 })
    const root = diff.paths.find((row) => row.path.join('/') === 'round')

    expect(root?.baseline.meanNs).toBe(71_000_000)
    expect(root?.baseline.meanNs).toBeGreaterThanOrEqual(70_000_000)
  })

  test('separates an overall improvement from a tail regression', () => {
    const baseline = model(1, 100)
    const candidate = model(1, 100)
    for (const instance of baseline.instances) {
      for (const root of instance.rootSpans) root.durationNs = 100_000
    }
    for (const instance of candidate.instances) {
      instance.rootSpans.forEach((root, index) => {
        root.durationNs = index < 3 ? 500_000 : 50_000
      })
    }

    const root = analyzePerformanceDiff(baseline, candidate, 0.02, { resamples: 20 }).root!

    expect(root.metrics.mean.relativeChange).toBeLessThan(0)
    expect(root.metrics.p95.relativeChange).toBeGreaterThan(0)
    expect(root.metrics.p95.reliable).toBe(true)
    expect(root.metrics.p99.reliable).toBe(false)
  })

  test('adjusts p-values monotonically in original order', () => {
    expect(adjustPValues([0.01, 0.04, 0.03, null])).toEqual([0.03, 0.04, 0.04, null])
  })

  test('analyzes every path in a realistic wide trace', () => {
    const diff = analyzePerformanceDiff(wideModel(1), wideModel(1.1), 0.02, {
      resamples: 300,
      seed: 9,
    })

    expect(diff.paths).toHaveLength(151)
  })
})
