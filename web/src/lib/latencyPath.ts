import type {
  LatencyAnalysis,
  LatencyContribution,
  LatencyOperation,
  LatencyPathSummary,
  LatencySegment,
  SpanNode,
  TraceModel,
} from './model'

const PATH_SEPARATOR = '\u001f'

interface TimedSpan {
  span: SpanNode
  path: string[]
  startNs: number
  endNs: number
  depth: number
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function quantile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0
  const ordered = [...values].sort((a, b) => a - b)
  const position = (ordered.length - 1) * percentile
  const low = Math.floor(position)
  const high = Math.ceil(position)
  if (low === high) return ordered[low]
  return ordered[low] + (ordered[high] - ordered[low]) * (position - low)
}

function timedSpans(root: SpanNode): TimedSpan[] {
  const spans: TimedSpan[] = []
  const visit = (span: SpanNode, parentPath: string[], depth: number) => {
    const path = [...parentPath, span.name]
    const startNs = span.startNs
    const endNs = Math.max(startNs, startNs + span.durationNs)
    spans.push({ span, path, startNs, endNs, depth })
    for (const child of span.children) visit(child, path, depth + 1)
  }
  visit(root, [], 0)
  return spans
}

function appendSegment(segments: LatencySegment[], segment: LatencySegment): void {
  const previous = segments.at(-1)
  const sameOwner = previous?.kind === segment.kind
    && previous.spanId === segment.spanId
    && previous.ambiguous === segment.ambiguous
  if (previous !== undefined && sameOwner && previous.startNs + previous.durationNs === segment.startNs) {
    previous.durationNs += segment.durationNs
    return
  }
  segments.push(segment)
}

export function attributeLatencyOperation(root: SpanNode): LatencyOperation {
  const spans = timedSpans(root)
  const startNs = Math.min(...spans.map((item) => item.startNs))
  const endNs = Math.max(...spans.map((item) => item.endNs))
  const boundaries = [...new Set(spans.flatMap((item) => [item.startNs, item.endNs]))].sort((a, b) => a - b)
  const contributions = new Map<string, LatencyContribution>()
  const segments: LatencySegment[] = []
  let attributedNs = 0
  let unattributedNs = 0
  let ambiguousNs = 0

  for (let index = 0; index < boundaries.length - 1; index++) {
    const segmentStart = boundaries[index]
    const segmentEnd = boundaries[index + 1]
    const durationNs = segmentEnd - segmentStart
    if (durationNs <= 0) continue

    const active = spans.filter((item) => item.startNs <= segmentStart && item.endNs >= segmentEnd)
    if (active.length === 0) {
      unattributedNs += durationNs
      appendSegment(segments, {
        kind: 'unattributed',
        startNs: segmentStart,
        durationNs,
        path: null,
        spanId: null,
        ambiguous: false,
      })
      continue
    }

    const deepest = Math.max(...active.map((item) => item.depth))
    const candidates = active
      .filter((item) => item.depth === deepest)
      .sort((a, b) => b.endNs - a.endNs || a.startNs - b.startNs || a.span.spanId.localeCompare(b.span.spanId))
    const owner = candidates[0]
    const ambiguous = candidates.length > 1
    const key = owner.path.join(PATH_SEPARATOR)
    const contribution = contributions.get(key)
    if (contribution === undefined) {
      contributions.set(key, { key, path: owner.path, durationNs })
    } else {
      contribution.durationNs += durationNs
    }
    attributedNs += durationNs
    if (ambiguous) ambiguousNs += durationNs
    appendSegment(segments, {
      kind: 'span',
      startNs: segmentStart,
      durationNs,
      path: owner.path,
      spanId: owner.span.spanId,
      ambiguous,
    })
  }

  return {
    rootSpanId: root.spanId,
    instanceId: root.instanceId,
    startNs,
    durationNs: endNs - startNs,
    attributedNs,
    unattributedNs,
    ambiguousNs,
    segments,
    contributions: [...contributions.values()].sort((a, b) => b.durationNs - a.durationNs),
  }
}

export function analyzeLatencyPaths(model: TraceModel): LatencyAnalysis {
  const operations = model.instances.flatMap((instance) => instance.rootSpans.map(attributeLatencyOperation))
  const operationCount = operations.length
  const pathValues = new Map<string, { path: string[]; values: number[] }>()

  for (const operation of operations) {
    for (const item of operation.contributions) {
      if (!pathValues.has(item.key)) pathValues.set(item.key, { path: item.path, values: [] })
    }
  }
  for (const operation of operations) {
    const byKey = new Map(operation.contributions.map((item) => [item.key, item]))
    for (const [key, item] of pathValues) item.values.push(byKey.get(key)?.durationNs ?? 0)
  }

  const paths: LatencyPathSummary[] = [...pathValues].map(([key, item]) => {
    const nonzero = item.values.filter((value) => value > 0).length
    return {
      key,
      path: item.path,
      meanNs: mean(item.values),
      p95Ns: quantile(item.values, 0.95),
      totalNs: item.values.reduce((sum, value) => sum + value, 0),
      coverage: nonzero / Math.max(1, operationCount),
    }
  }).sort((a, b) => b.meanNs - a.meanNs)

  const byInstance = new Map<string, number[]>()
  for (const operation of operations) {
    const values = byInstance.get(operation.instanceId)
    if (values === undefined) byInstance.set(operation.instanceId, [operation.durationNs])
    else values.push(operation.durationNs)
  }
  const instances = [...byInstance].map(([instanceId, values]) => ({
    instanceId,
    meanNs: mean(values),
    p95Ns: quantile(values, 0.95),
    operations: values.length,
  })).sort((a, b) => b.meanNs - a.meanNs)
  const representative = [...operations].sort((a, b) => a.durationNs - b.durationNs)[Math.floor(operations.length / 2)] ?? null

  return {
    operations,
    representative,
    paths,
    instances,
    meanDurationNs: mean(operations.map((operation) => operation.durationNs)),
    p95DurationNs: quantile(operations.map((operation) => operation.durationNs), 0.95),
    meanUnattributedNs: mean(operations.map((operation) => operation.unattributedNs)),
    meanAmbiguousNs: mean(operations.map((operation) => operation.ambiguousNs)),
  }
}
