import { describe, expect, test } from 'bun:test'
import type { SpanNode } from './model'
import { attributeLatencyOperation } from './latencyPath'

function span(name: string, startNs: number, durationNs: number, children: SpanNode[] = []): SpanNode {
  const node: SpanNode = {
    spanId: `${name}-${startNs}`,
    parentSpanId: null,
    traceId: 'trace',
    name,
    kind: 'internal',
    startNs,
    durationNs,
    attributes: {},
    events: [],
    status: 'unset',
    statusMessage: '',
    level: null,
    instanceId: 'node-0',
    children,
    depth: 0,
  }
  for (const child of children) {
    child.parentSpanId = node.spanId
    child.depth = node.depth + 1
  }
  return node
}

describe('attributeLatencyOperation', () => {
  test('counts parallel wall time once and records ambiguous overlap', () => {
    const root = span('root', 0, 100, [
      span('first', 10, 50),
      span('second', 40, 50),
    ])

    const result = attributeLatencyOperation(root)
    const byPath = new Map(result.contributions.map((item) => [item.path.join('/'), item.durationNs]))

    expect(result.durationNs).toBe(100)
    expect(result.attributedNs + result.unattributedNs).toBe(100)
    expect(result.ambiguousNs).toBe(20)
    expect(byPath.get('root')).toBe(20)
    expect(byPath.get('root/first')).toBe(30)
    expect(byPath.get('root/second')).toBe(50)
  })

  test('preserves gaps before asynchronous descendants as unattributed', () => {
    const root = span('root', 0, 20, [span('async', 40, 20)])

    const result = attributeLatencyOperation(root)

    expect(result.durationNs).toBe(60)
    expect(result.attributedNs).toBe(40)
    expect(result.unattributedNs).toBe(20)
    expect(result.segments.map((segment) => [segment.kind, segment.durationNs])).toEqual([
      ['span', 20],
      ['unattributed', 20],
      ['span', 20],
    ])
  })

  test('attributes nested intervals to the deepest active span', () => {
    const root = span('root', 0, 100, [
      span('child', 10, 80, [span('nested', 20, 20)]),
    ])

    const result = attributeLatencyOperation(root)
    const byPath = new Map(result.contributions.map((item) => [item.path.at(-1), item.durationNs]))

    expect(byPath.get('root')).toBe(20)
    expect(byPath.get('child')).toBe(60)
    expect(byPath.get('nested')).toBe(20)
  })
})
