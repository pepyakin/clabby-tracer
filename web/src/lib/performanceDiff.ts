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

function random(seed: number): () => number {
  let state = seed || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

interface DenseInstance {
  baseline: Float64Array[]
  candidate: Float64Array[]
}

interface ResamplingResult {
  intervals: Array<{ low: number; high: number } | null>
  pValues: number[]
}

function denseRows(
  operations: readonly Operation[],
  pathIndexes: ReadonlyMap<string, number>,
  pathCount: number,
): Float64Array[] {
  return operations.map((operation) => {
    const row = new Float64Array(pathCount)
    for (const [key, cost] of operation.costs) {
      const index = pathIndexes.get(key)
      if (index !== undefined) row[index] = cost.durationNs
    }
    return row
  })
}

function addRow(target: Float64Array, row: Float64Array, weight: number): void {
  for (let path = 0; path < target.length; path++) target[path] += row[path] * weight
}

/**
 * Generate each bootstrap/permutation schedule once and apply it to every path.
 * The old path-at-a-time implementation repeated identical allocation and
 * shuffle work for every path, making wide traces scale quadratically in
 * practice.
 */
function resamplePaths(
  baseline: Samples,
  candidate: Samples,
  keys: readonly string[],
  instanceIds: readonly string[],
  count: number,
  seed: number,
): ResamplingResult {
  const pathCount = keys.length
  const pathIndexes = new Map(keys.map((key, index) => [key, index]))
  const instances: DenseInstance[] = instanceIds.map((id) => ({
    baseline: denseRows(baseline.byInstance.get(id) ?? [], pathIndexes, pathCount),
    candidate: denseRows(candidate.byInstance.get(id) ?? [], pathIndexes, pathCount),
  }))
  const observed = new Float64Array(pathCount)
  for (let path = 0; path < pathCount; path++) {
    observed[path] = Math.abs(
      equalInstanceMean(candidate.byInstance, keys[path]) -
      equalInstanceMean(baseline.byInstance, keys[path]),
    )
  }

  const distributions = Array.from({ length: pathCount }, () => new Float64Array(count))
  const distributionLengths = new Uint32Array(pathCount)
  const extreme = new Uint32Array(pathCount)
  const bootstrapRandom = random(seed)
  const permutationRandom = random(seed ^ 0xa5a5a5a5)
  const instanceWeight = 1 / instances.length

  for (let sample = 0; sample < count; sample++) {
    const baselineTotal = new Float64Array(pathCount)
    const candidateTotal = new Float64Array(pathCount)
    for (let slot = 0; slot < instances.length; slot++) {
      const instance = instances[Math.floor(bootstrapRandom() * instances.length)]
      const baselineWeight = instanceWeight / instance.baseline.length
      const candidateWeight = instanceWeight / instance.candidate.length
      for (let operation = 0; operation < instance.baseline.length; operation++) {
        addRow(
          baselineTotal,
          instance.baseline[Math.floor(bootstrapRandom() * instance.baseline.length)],
          baselineWeight,
        )
      }
      for (let operation = 0; operation < instance.candidate.length; operation++) {
        addRow(
          candidateTotal,
          instance.candidate[Math.floor(bootstrapRandom() * instance.candidate.length)],
          candidateWeight,
        )
      }
    }
    for (let path = 0; path < pathCount; path++) {
      if (baselineTotal[path] <= 0) continue
      distributions[path][distributionLengths[path]++] = candidateTotal[path] / baselineTotal[path] - 1
    }

    const permutedBaseline = new Float64Array(pathCount)
    const permutedCandidate = new Float64Array(pathCount)
    for (const instance of instances) {
      const baselineCount = instance.baseline.length
      const candidateCount = instance.candidate.length
      const pool = [...instance.baseline, ...instance.candidate]
      for (let index = pool.length - 1; index > 0; index--) {
        const swap = Math.floor(permutationRandom() * (index + 1))
        ;[pool[index], pool[swap]] = [pool[swap], pool[index]]
      }
      const baselineWeight = instanceWeight / baselineCount
      const candidateWeight = instanceWeight / candidateCount
      for (let operation = 0; operation < baselineCount; operation++) {
        addRow(permutedBaseline, pool[operation], baselineWeight)
      }
      for (let operation = baselineCount; operation < pool.length; operation++) {
        addRow(permutedCandidate, pool[operation], candidateWeight)
      }
    }
    for (let path = 0; path < pathCount; path++) {
      if (Math.abs(permutedCandidate[path] - permutedBaseline[path]) >= observed[path]) extreme[path]++
    }
  }

  return {
    intervals: distributions.map((distribution, path) => {
      const length = distributionLengths[path]
      if (length === 0) return null
      const values = Array.from(distribution.subarray(0, length))
      return { low: quantile(values, 0.025), high: quantile(values, 0.975) }
    }),
    pValues: Array.from(extreme, (value) => (value + 1) / (count + 1)),
  }
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
  const keys = [...new Set([...baseline.paths.keys(), ...candidate.paths.keys()])]
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
      relativeInterval: null,
      rawP: null,
      adjustedP: null,
      evidence: 'descriptive',
      baselineCalls: baselineCosts.reduce((sum, cost) => sum + cost.calls, 0),
      candidateCalls: candidateCosts.reduce((sum, cost) => sum + cost.calls, 0),
      baselineCoverage: baselineCoverage / Math.max(1, baseline.operations.length),
      candidateCoverage: candidateCoverage / Math.max(1, candidate.operations.length),
      baselineErrors: baselineCosts.reduce((sum, cost) => sum + cost.errors, 0),
      candidateErrors: candidateCosts.reduce((sum, cost) => sum + cost.errors, 0),
      instances,
      baselineValuesNs: baselineValues,
      candidateValuesNs: candidateValues,
    })
  }

  if (inferential) {
    const resampling = resamplePaths(
      baseline,
      candidate,
      keys,
      baselineInstances,
      resamples,
      baseSeed,
    )
    rows.forEach((row, index) => {
      row.relativeInterval = row.baseline.meanNs > 0 ? resampling.intervals[index] : null
      row.rawP = resampling.pValues[index]
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
