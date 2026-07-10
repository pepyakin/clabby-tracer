import type {
  PerformanceDiff,
  PerformanceEstimate,
  PerformanceEvidence,
  PerformanceInstanceDiff,
  PerformancePathDiff,
  SpanNode,
  TraceModel,
} from './model'

const PATH_SEPARATOR = '\u001f'
const DEFAULT_RESAMPLES = 10_000
const MIN_SAMPLES = 10

interface PathCost {
  durationNs: number
  calls: number
  errors: number
}

interface Operation {
  instanceId: string
  costs: Map<string, PathCost>
}

interface Samples {
  operations: Operation[]
  paths: Map<string, string[]>
  byInstance: Map<string, Operation[]>
}

export interface PerformanceAnalysisOptions {
  resamples?: number
  seed?: number
}

function pathKey(path: readonly string[]): string {
  return path.join(PATH_SEPARATOR)
}

function collectOperation(root: SpanNode, paths: Map<string, string[]>): Operation {
  const costs = new Map<string, PathCost>()
  const visit = (span: SpanNode, path: string[]): void => {
    const nextPath = [...path, span.name]
    const key = pathKey(nextPath)
    paths.set(key, nextPath)
    const cost = costs.get(key) ?? { durationNs: 0, calls: 0, errors: 0 }
    cost.durationNs += span.durationNs
    cost.calls++
    if (span.status === 'error' || span.level === 'error') cost.errors++
    costs.set(key, cost)
    for (const child of span.children) visit(child, nextPath)
  }
  visit(root, [])
  return { instanceId: root.instanceId, costs }
}

function samples(model: TraceModel): Samples {
  const paths = new Map<string, string[]>()
  const operations: Operation[] = []
  const byInstance = new Map<string, Operation[]>()
  for (const instance of model.instances) {
    for (const root of instance.rootSpans) {
      const operation = collectOperation(root, paths)
      operations.push(operation)
      const list = byInstance.get(instance.id)
      if (list === undefined) byInstance.set(instance.id, [operation])
      else list.push(operation)
    }
  }
  return { operations, paths, byInstance }
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b)
}

function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const xs = sorted(values)
  const at = (xs.length - 1) * p
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  if (lo === hi) return xs[lo]
  return xs[lo] + (xs[hi] - xs[lo]) * (at - lo)
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function outlierCount(values: readonly number[]): number {
  if (values.length < 4) return 0
  const q1 = quantile(values, 0.25)
  const q3 = quantile(values, 0.75)
  const iqr = q3 - q1
  const low = q1 - 1.5 * iqr
  const high = q3 + 1.5 * iqr
  return values.filter((value) => value < low || value > high).length
}

function estimate(values: readonly number[]): PerformanceEstimate {
  const med = quantile(values, 0.5)
  return {
    meanNs: mean(values),
    medianNs: med,
    p95Ns: quantile(values, 0.95),
    madNs: quantile(values.map((value) => Math.abs(value - med)), 0.5),
    samples: values.length,
    outliers: outlierCount(values),
  }
}

function valuesFor(operations: readonly Operation[], key: string): number[] {
  return operations.map((operation) => operation.costs.get(key)?.durationNs ?? 0)
}

function equalInstanceMean(byInstance: Map<string, Operation[]>, key: string): number {
  return mean([...byInstance.values()].map((operations) => mean(valuesFor(operations, key))))
}

function hash(value: string): number {
  let out = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    out ^= value.charCodeAt(i)
    out = Math.imul(out, 0x01000193)
  }
  return out >>> 0
}

function random(seed: number): () => number {
  let state = seed || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function resampledMean(values: readonly number[], rand: () => number): number {
  let total = 0
  for (let i = 0; i < values.length; i++) total += values[Math.floor(rand() * values.length)]
  return values.length === 0 ? 0 : total / values.length
}

function bootstrapRelative(
  baseline: Samples,
  candidate: Samples,
  key: string,
  instanceIds: readonly string[],
  count: number,
  seed: number,
): { low: number; high: number } | null {
  const rand = random(seed)
  const changes: number[] = []
  for (let n = 0; n < count; n++) {
    let baselineTotal = 0
    let candidateTotal = 0
    for (let i = 0; i < instanceIds.length; i++) {
      const id = instanceIds[Math.floor(rand() * instanceIds.length)]
      baselineTotal += resampledMean(valuesFor(baseline.byInstance.get(id) ?? [], key), rand)
      candidateTotal += resampledMean(valuesFor(candidate.byInstance.get(id) ?? [], key), rand)
    }
    const baselineMean = baselineTotal / instanceIds.length
    if (baselineMean <= 0) continue
    changes.push(candidateTotal / instanceIds.length / baselineMean - 1)
  }
  if (changes.length === 0) return null
  return { low: quantile(changes, 0.025), high: quantile(changes, 0.975) }
}

function permutationP(
  baseline: Samples,
  candidate: Samples,
  key: string,
  instanceIds: readonly string[],
  count: number,
  seed: number,
): number {
  const observed = Math.abs(
    equalInstanceMean(candidate.byInstance, key) - equalInstanceMean(baseline.byInstance, key),
  )
  const rand = random(seed)
  let extreme = 0
  for (let n = 0; n < count; n++) {
    let leftTotal = 0
    let rightTotal = 0
    for (const id of instanceIds) {
      const left = valuesFor(baseline.byInstance.get(id) ?? [], key)
      const right = valuesFor(candidate.byInstance.get(id) ?? [], key)
      const pool = [...left, ...right]
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[pool[i], pool[j]] = [pool[j], pool[i]]
      }
      leftTotal += mean(pool.slice(0, left.length))
      rightTotal += mean(pool.slice(left.length))
    }
    const delta = Math.abs((rightTotal - leftTotal) / instanceIds.length)
    if (delta >= observed) extreme++
  }
  return (extreme + 1) / (count + 1)
}

/** Benjamini-Hochberg adjusted p-values in the same order as the input. */
export function adjustPValues(values: readonly (number | null)[]): (number | null)[] {
  const ranked = values
    .map((value, index) => ({ value, index }))
    .filter((item): item is { value: number; index: number } => item.value !== null)
    .sort((a, b) => a.value - b.value)
  const out: (number | null)[] = values.map(() => null)
  let next = 1
  for (let i = ranked.length - 1; i >= 0; i--) {
    const adjusted = Math.min(next, (ranked[i].value * ranked.length) / (i + 1), 1)
    next = adjusted
    out[ranked[i].index] = adjusted
  }
  return out
}

function evidenceFor(path: PerformancePathDiff, threshold: number, inferential: boolean): PerformanceEvidence {
  if (path.baselineCoverage === 0) return 'added'
  if (path.candidateCoverage === 0) return 'removed'
  if (!inferential || path.relativeInterval === null || path.adjustedP === null) return 'descriptive'
  if (path.relativeInterval.low >= -threshold && path.relativeInterval.high <= threshold) {
    return 'within-noise'
  }
  if (path.adjustedP < 0.05 && path.relativeInterval.low > threshold) return 'regressed'
  if (path.adjustedP < 0.05 && path.relativeInterval.high < -threshold) return 'improved'
  return 'inconclusive'
}

export function analyzePerformanceDiff(
  baselineModel: TraceModel,
  candidateModel: TraceModel,
  threshold: number,
  options: PerformanceAnalysisOptions = {},
): PerformanceDiff {
  const baseline = samples(baselineModel)
  const candidate = samples(candidateModel)
  const baselineInstances = [...baseline.byInstance.keys()].sort()
  const candidateInstances = [...candidate.byInstance.keys()].sort()
  const sameInstances =
    baselineInstances.length > 0 &&
    baselineInstances.length === candidateInstances.length &&
    baselineInstances.every((id, index) => id === candidateInstances[index])
  const inferential =
    sameInstances &&
    baseline.operations.length >= MIN_SAMPLES &&
    candidate.operations.length >= MIN_SAMPLES
  const warning = inferential
    ? null
    : !sameInstances
      ? 'Node sets differ, so results are descriptive only.'
      : `At least ${MIN_SAMPLES} operations per side are required for confidence intervals and adjusted p-values.`
  const keys = new Set([...baseline.paths.keys(), ...candidate.paths.keys()])
  const resamples = options.resamples ?? DEFAULT_RESAMPLES
  const baseSeed = options.seed ?? 0x6d2b79f5
  const rows: PerformancePathDiff[] = []

  for (const key of keys) {
    const path = baseline.paths.get(key) ?? candidate.paths.get(key) ?? []
    const baselineValues = valuesFor(baseline.operations, key)
    const candidateValues = valuesFor(candidate.operations, key)
    const baselineMean = equalInstanceMean(baseline.byInstance, key)
    const candidateMean = equalInstanceMean(candidate.byInstance, key)
    const baselineCoverage = baseline.operations.filter((op) => op.costs.has(key)).length
    const candidateCoverage = candidate.operations.filter((op) => op.costs.has(key)).length
    const relativeChange = baselineMean > 0 ? candidateMean / baselineMean - 1 : null
    const pathSeed = baseSeed ^ hash(key)
    const relativeInterval = inferential && baselineMean > 0
      ? bootstrapRelative(baseline, candidate, key, baselineInstances, resamples, pathSeed)
      : null
    const rawP = inferential
      ? permutationP(baseline, candidate, key, baselineInstances, resamples, pathSeed ^ 0xa5a5a5a5)
      : null
    const instances: PerformanceInstanceDiff[] = [...new Set([...baselineInstances, ...candidateInstances])]
      .sort()
      .map((instanceId) => {
        const before = baseline.byInstance.get(instanceId)
        const after = candidate.byInstance.get(instanceId)
        const beforeMean = before === undefined ? null : mean(valuesFor(before, key))
        const afterMean = after === undefined ? null : mean(valuesFor(after, key))
        return {
          instanceId,
          baselineMeanNs: beforeMean,
          candidateMeanNs: afterMean,
          relativeChange: beforeMean !== null && beforeMean > 0 && afterMean !== null
            ? afterMean / beforeMean - 1
            : null,
          baselineSamples: before?.length ?? 0,
          candidateSamples: after?.length ?? 0,
        }
      })
    const baselineCosts = baseline.operations.flatMap((op) => {
      const cost = op.costs.get(key)
      return cost === undefined ? [] : [cost]
    })
    const candidateCosts = candidate.operations.flatMap((op) => {
      const cost = op.costs.get(key)
      return cost === undefined ? [] : [cost]
    })
    rows.push({
      key,
      path,
      depth: Math.max(0, path.length - 1),
      baseline: { ...estimate(baselineValues), meanNs: baselineMean },
      candidate: { ...estimate(candidateValues), meanNs: candidateMean },
      absoluteChangeNs: candidateMean - baselineMean,
      relativeChange,
      relativeInterval,
      rawP,
      adjustedP: null,
      evidence: 'descriptive',
      baselineCalls: baselineCosts.reduce((sum, cost) => sum + cost.calls, 0),
      candidateCalls: candidateCosts.reduce((sum, cost) => sum + cost.calls, 0),
      baselineCoverage: baselineCoverage / Math.max(1, baseline.operations.length),
      candidateCoverage: candidateCoverage / Math.max(1, candidate.operations.length),
      baselineErrors: baselineCosts.reduce((sum, cost) => sum + cost.errors, 0),
      candidateErrors: candidateCosts.reduce((sum, cost) => sum + cost.errors, 0),
      instances,
    })
  }

  const adjusted = adjustPValues(rows.map((row) => row.rawP))
  rows.forEach((row, index) => {
    row.adjustedP = adjusted[index]
    row.evidence = evidenceFor(row, threshold, inferential)
  })
  rows.sort((a, b) => Math.abs(b.absoluteChangeNs) - Math.abs(a.absoluteChangeNs))
  const root = rows
    .filter((row) => row.depth === 0)
    .sort((a, b) => b.baseline.meanNs + b.candidate.meanNs - a.baseline.meanNs - a.candidate.meanNs)[0] ?? null
  return {
    paths: rows,
    root,
    baselineOperations: baseline.operations.length,
    candidateOperations: candidate.operations.length,
    baselineInstances,
    candidateInstances,
    inferential,
    warning,
    threshold,
  }
}
