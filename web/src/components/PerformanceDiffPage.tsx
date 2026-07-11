import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, type WheelEvent as ReactWheelEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { compareQueryLabel } from '../api/client'
import type {
  PerformanceDiffPageProps,
  PerformanceDiff,
  PerformanceInstanceDiff,
  PerformanceMetric,
  PerformanceMetricDiff,
  PerformancePathDiff,
  PerformanceSource,
  TraceModel,
} from '../lib/model'
import { colorIndexForService, instanceColorVar } from '../lib/model'
import { formatNs, shortId } from '../lib/format'
import FlameTimeline from './FlameTimeline'
import LatencyPathDiff from './LatencyPathDiff'
import { CumulativeDistributionPlot, NodeDistributionPlot, quantileValue } from './DistributionPlots'
import PerformanceSourceModal from './PerformanceSourceModal'
import './PerformanceDiffPage.css'

function sourceSpanName(source: PerformanceSource | null): string {
  if (source === null) return ''
  if (source.kind === 'query') return new URLSearchParams(source.query).get('name')?.trim() ?? ''
  return source.model.instances[0]?.rootSpans[0]?.name ?? ''
}

interface SourceCardProps {
  side: 'baseline' | 'candidate'
  source: PerformanceSource | null
  loading: boolean
  error: string | null
  onChoose: () => void
  onClear: () => void
}

function SourceCard({ side, source, loading, error, onChoose, onClear }: SourceCardProps) {
  return (
    <section className="panel pd-source">
      <div className="panel-header">
        <span className="panel-title">{side}</span>
        {source !== null && <span className="chip pd-source-kind">{source.kind}</span>}
        {source !== null && (
          <button type="button" className="btn btn-ghost btn-sm pd-source-clear" onClick={onClear}>
            clear
          </button>
        )}
      </div>
      {source !== null ? (
        <div className="pd-source-current">
          <span className="pd-source-label" title={source.label}>{source.label}</span>
          {loading && <span className="spinner" />}
          {source.kind !== 'query' && (
            <span className="faint mono-num">
              {source.model.instances.length} nodes · {source.model.instances.reduce((sum, instance) => sum + instance.rootSpans.length, 0)} operations
            </span>
          )}
        </div>
      ) : (
        <div className="pd-source-empty pd-source-choose">
          <div>
            <strong>Choose {side}</strong>
            <span className="faint">Search spans or upload a trace export.</span>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={onChoose}>choose source</button>
        </div>
      )}
      {error !== null && <div className="pd-source-error">{error}</div>}
    </section>
  )
}

function percent(value: number | null, signed = true): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const prefix = signed && value > 0 ? '+' : ''
  return `${prefix}${(value * 100).toFixed(Math.abs(value) < 0.1 ? 1 : 0)}%`
}

function pValue(value: number | null): string {
  if (value === null) return '—'
  if (value < 0.001) return '<0.001'
  return value.toFixed(3)
}

const PERFORMANCE_METRICS: PerformanceMetric[] = ['mean', 'median', 'p95', 'p99']

function metricLabel(metric: PerformanceMetric): string {
  return metric === 'median' ? 'p50' : metric
}

function interval(metric: PerformanceMetricDiff): string {
  if (metric.relativeInterval === null) return '—'
  return `[${percent(metric.relativeInterval.low)}, ${percent(metric.relativeInterval.high)}]`
}

function usePerformanceAnalysis(
  baseline: TraceModel | null,
  candidate: TraceModel | null,
  threshold: number,
): { result: PerformanceDiff | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ result: PerformanceDiff | null; loading: boolean; error: string | null }>({
    result: null,
    loading: false,
    error: null,
  })
  useEffect(() => {
    if (baseline === null || candidate === null) {
      setState({ result: null, loading: false, error: null })
      return
    }
    const id = Date.now() + Math.random()
    const worker = new Worker(new URL('../lib/performanceDiff.worker.ts', import.meta.url), { type: 'module' })
    setState({ result: null, loading: true, error: null })
    worker.onmessage = (event: MessageEvent<{ id: number; result?: PerformanceDiff; error?: string }>) => {
      if (event.data.id !== id) return
      setState({
        result: event.data.result ?? null,
        loading: false,
        error: event.data.error ?? null,
      })
      worker.terminate()
    }
    worker.onerror = (event) => {
      setState({ result: null, loading: false, error: event.message })
      worker.terminate()
    }
    worker.postMessage({ id, baseline, candidate, threshold })
    return () => worker.terminate()
  }, [baseline, candidate, threshold])
  return state
}

function Evidence({ row, metric = 'mean' }: { row: PerformancePathDiff; metric?: PerformanceMetric }) {
  const result = row.metrics[metric]
  if (!result.reliable) {
    return <span className="pd-evidence pd-descriptive" title="Too few observations to estimate this tail reliably">sparse tail</span>
  }
  if (result.evidence !== 'inconclusive') {
    const arrow = result.evidence === 'regressed' ? '↑' : result.evidence === 'improved' ? '↓' : ''
    return <span className={`pd-evidence pd-${result.evidence}`}>{arrow} {result.evidence.replace('-', ' ')}</span>
  }

  const direction = (result.relativeChange ?? 0) <= 0 ? 'faster' : 'slower'
  const arrow = direction === 'faster' ? '↓' : '↑'
  const intervalCrossesZero = result.relativeInterval !== null
    && result.relativeInterval.low <= 0
    && result.relativeInterval.high >= 0
  const adjustedPIsHigh = result.adjustedP !== null && result.adjustedP >= 0.05

  let reason = 'confidence interval overlaps the noise threshold'
  if (intervalCrossesZero) reason = 'confidence interval crosses zero'
  else if (adjustedPIsHigh) reason = `adjusted p-value is ${pValue(result.adjustedP)}`

  return <span
    className="pd-evidence pd-inconclusive"
    title={`Observed ${direction}, but the result is not statistically resolved because the ${reason}.`}
  >
    {arrow} {direction} trend · {intervalCrossesZero ? 'CI crosses zero' : adjustedPIsHigh ? `adjusted p ${pValue(result.adjustedP)}` : 'overlaps noise'}
  </span>
}

function MetricPicker({ value, onChange }: { value: PerformanceMetric; onChange: (metric: PerformanceMetric) => void }) {
  return <span className="pd-metric-picker" aria-label="color flamegraph by">
    <span className="faint">color by</span>
    {PERFORMANCE_METRICS.map((metric) => <button
      type="button"
      className={`chip ${value === metric ? 'active' : ''}`}
      key={metric}
      onClick={() => onChange(metric)}
    >{metricLabel(metric)}</button>)}
  </span>
}

function ComparisonSummary({ row, diff, metric }: { row: PerformancePathDiff; diff: PerformanceDiff; metric: PerformanceMetric }) {
  const mean = row.metrics.mean.relativeChange
  const tail = row.metrics.p95.relativeChange
  const mixed = row.metrics.p95.reliable
    && mean !== null
    && tail !== null
    && ((mean < -diff.threshold && tail > diff.threshold) || (mean > diff.threshold && tail < -diff.threshold))
  const verdict = mixed
    ? `${mean < 0 ? 'faster overall' : 'slower overall'} · ${tail > 0 ? 'worse tail' : 'better tail'}`
    : mean !== null && mean < -diff.threshold ? 'broad improvement' : mean !== null && mean > diff.threshold ? 'broad regression' : 'stable overall'
  return (
    <div className="pd-summary-line">
      <strong title={row.path.join(' / ')}>{row.path.at(-1)}</strong>
      {(['mean', 'median', 'p95', 'p99'] as const).map((item) => <span className={`pd-summary-metric${metric === item ? ' active' : ''}`} key={item}>
        <span className="faint">{metricLabel(item)}</span>
        <strong className={`mono-num pd-direction ${(row.metrics[item].relativeChange ?? 0) > 0 ? 'slower' : 'faster'}`}>{percent(row.metrics[item].relativeChange)}</strong>
        {!row.metrics[item].reliable && <i title="Too few observations for a reliable estimate">sparse</i>}
      </span>)}
      <span className={`pd-mixed-verdict${mixed ? ' mixed' : ''}`}>{verdict}</span>
      <span className="pd-summary-samples faint">{diff.comparisonMode} · {diff.baselineInstances.length} → {diff.candidateInstances.length} nodes</span>
    </div>
  )
}

interface FlameCell {
  row: PerformancePathDiff
  left: number
  width: number
  depth: number
}

interface FlameView {
  low: number
  high: number
}

export function projectFlameCell(cell: FlameCell, plotWidth: number, view: FlameView): { left: number; width: number } {
  const scale = plotWidth / Math.max(0.001, view.high - view.low)
  const start = (cell.left - view.low) * scale
  const end = (cell.left + cell.width - view.low) * scale
  const left = Math.max(0, start)
  const right = Math.min(plotWidth, end)
  return { left, width: Math.max(0, right - left - 2) }
}

export function layoutFlame(rows: PerformancePathDiff[], focusedKey: string | null): { cells: FlameCell[]; depth: number } {
  const focus = focusedKey === null ? null : rows.find((row) => row.key === focusedKey) ?? null
  const visible = focus === null
    ? rows
    : rows.filter((row) => focus.path.every((part, index) => row.path[index] === part))
  const visibleKeys = new Set(visible.map((row) => row.key))
  const children = new Map<string, PerformancePathDiff[]>()
  const roots: PerformancePathDiff[] = []
  for (const row of visible) {
    const parentKey = row.path.slice(0, -1).join('\u001f')
    if (row.key === focus?.key || !visibleKeys.has(parentKey)) {
      roots.push(row)
      continue
    }
    const siblings = children.get(parentKey)
    if (siblings === undefined) children.set(parentKey, [row])
    else siblings.push(row)
  }
  const cells: FlameCell[] = []
  const weight = (row: PerformancePathDiff) => {
    const baselineCost = row.instances.reduce((sum, instance) => sum + (instance.baselineMeanNs ?? 0), 0)
    const candidateCost = row.instances.reduce((sum, instance) => sum + (instance.candidateMeanNs ?? 0), 0)
    return Math.max(1, baselineCost, candidateCost)
  }
  const place = (siblings: PerformancePathDiff[], left: number, width: number, depth: number): void => {
    const ordered = [...siblings].sort((a, b) => weight(b) - weight(a))
    const total = ordered.reduce((sum, row) => sum + weight(row), 0)
    const scale = width / total
    let cursor = left
    for (const row of ordered) {
      const cellWidth = weight(row) * scale
      cells.push({ row, left: cursor, width: cellWidth, depth })
      const descendants = children.get(row.key)
      if (descendants !== undefined) {
        place(descendants, cursor, cellWidth, depth + 1)
      }
      cursor += cellWidth
    }
  }
  place(roots, 0, 100, 0)
  return { cells, depth: Math.max(0, ...cells.map((cell) => cell.depth)) }
}

function frameBackground(row: PerformancePathDiff, metric: PerformanceMetric): string | undefined {
  const result = row.metrics[metric]
  if (result.evidence === 'added' || result.evidence === 'removed') return undefined
  if (result.relativeChange === null || result.relativeChange === 0) return undefined
  const token = result.relativeChange > 0 ? '--perf-regressed' : '--perf-improved'
  const strength = Math.min(76, 18 + Math.abs(result.relativeChange) * 110)
  return `color-mix(in srgb, var(${token}) ${strength}%, var(--surface-hover))`
}

function ImpactTree({ rows, metric, onMetricChange, selectedKey, onSelect }: {
  rows: PerformancePathDiff[]
  metric: PerformanceMetric
  onMetricChange: (metric: PerformanceMetric) => void
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [plotWidth, setPlotWidth] = useState(0)
  const [plotHeight, setPlotHeight] = useState(0)
  const [view, setView] = useState<FlameView>({ low: 0, high: 100 })
  const flameRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const minimapRef = useRef<HTMLDivElement | null>(null)
  const layout = useMemo(() => layoutFlame(rows, focusedKey), [rows, focusedKey])
  const match = query.trim().toLowerCase()
  const focused = focusedKey === null ? null : rows.find((row) => row.key === focusedKey) ?? null
  const rowHeight = Math.min(30, Math.max(22, plotHeight / (layout.depth + 1)))
  const barHeight = rowHeight - 4
  const projected = useMemo(() => layout.cells.flatMap((cell) => {
    const position = projectFlameCell(cell, plotWidth, view)
    if (position.width <= 0) return []
    return [{ cell, position }]
  }), [layout.cells, plotWidth, view])

  useLayoutEffect(() => {
    const flame = flameRef.current
    const viewport = viewportRef.current
    if (flame === null || viewport === null) return
    const resize = () => {
      setPlotWidth(flame.clientWidth)
      setPlotHeight(viewport.clientHeight)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(flame)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  useEffect(() => setView({ low: 0, high: 100 }), [focusedKey])

  const zoomAt = (anchor: number, factor: number) => {
    setView((current) => {
      const span = Math.min(100, Math.max(2, (current.high - current.low) * factor))
      const position = (anchor - current.low) / (current.high - current.low)
      const low = Math.min(100 - span, Math.max(0, anchor - span * position))
      return { low, high: low + span }
    })
  }

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const amount = event.shiftKey && event.deltaX === 0
      ? event.deltaY
      : Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : 0
    if (amount === 0) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const cursor = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    const anchor = view.low + cursor * (view.high - view.low)
    const delta = event.deltaMode === 1 ? amount * 24 : amount
    zoomAt(anchor, Math.exp(delta * 0.0022))
  }

  return (
    <section className="panel pd-flame-panel">
      <div className="pd-flame-toolbar">
        <div>
          <span className="panel-title">aggregate differential call tree</span>
          <span className="pd-flame-help faint">width = aggregate cost · color = {metricLabel(metric)} change · double-click = focus</span>
        </div>
        <div className="pd-flame-actions">
          <MetricPicker value={metric} onChange={onMetricChange} />
          <input className="input pd-flame-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="find a span" aria-label="find a span" />
          {(view.low > 0 || view.high < 100) && <button type="button" className="btn btn-sm" onClick={() => setView({ low: 0, high: 100 })}>reset zoom</button>}
          {focused !== null && <button type="button" className="btn btn-sm" onClick={() => setFocusedKey(null)}>reset focus</button>}
        </div>
      </div>
      {focused !== null && <div className="pd-focus-path"><span className="faint">focused</span> {focused.path.join(' / ')}</div>}
      <FlameTimeline
        low={0}
        high={100}
        viewLow={view.low}
        viewHigh={view.high}
        trackRef={minimapRef}
        onChange={(low, high) => {
          const span = Math.min(100, Math.max(2, high - low))
          const nextLow = Math.min(100 - span, Math.max(0, low))
          setView({ low: nextLow, high: nextLow + span })
        }}
        onReset={() => setView({ low: 0, high: 100 })}
      >
        <div className="pd-flame-minimap-bars fg-timeline-minimap" aria-hidden="true">
          {layout.cells.map((cell) => <i key={cell.row.key} style={{
            left: `${cell.left}%`,
            width: `${cell.width}%`,
            top: `${cell.depth * 3}px`,
            background: frameBackground(cell.row, metric),
          }} />)}
        </div>
      </FlameTimeline>
      <div ref={viewportRef} className="pd-flame-viewport" onWheel={onWheel}>
        <div ref={flameRef} className="pd-flame" style={{ minHeight: `${(layout.depth + 1) * rowHeight + 4}px` }}>
          {projected.map(({ cell, position }) => {
            const matching = match !== '' && cell.row.path.some((part) => part.toLowerCase().includes(match))
            const dimmed = match !== '' && !matching
            return <button
              type="button"
              key={cell.row.key}
              className={`pd-frame pd-${cell.row.metrics[metric].evidence}${selectedKey === cell.row.key ? ' selected' : ''}${matching ? ' matching' : ''}${dimmed ? ' dimmed' : ''}`}
              style={{
                left: `${position.left}px`,
                width: `${position.width}px`,
                paddingInline: position.width >= 48 ? '8px' : position.width >= 20 ? '4px' : '0',
                top: `${cell.depth * rowHeight + 2}px`,
                height: `${barHeight}px`,
                background: frameBackground(cell.row, metric),
              }}
              onClick={() => onSelect(cell.row.key)}
              onDoubleClick={() => setFocusedKey(cell.row.key)}
              title={`${cell.row.path.join(' / ')}\n${metricLabel(metric)}: ${formatNs(cell.row.metrics[metric].baselineNs)} → ${formatNs(cell.row.metrics[metric].candidateNs)} (${percent(cell.row.metrics[metric].relativeChange)})${cell.row.metrics[metric].reliable ? '' : '\nSparse tail: treat this as descriptive.'}`}
            >
              <span className="pd-frame-name">{cell.row.path.at(-1)}</span>
              <span className="pd-frame-delta mono-num">{percent(cell.row.metrics[metric].relativeChange)}</span>
            </button>
          })}
        </div>
      </div>
      <div className="pd-flame-legend">
        <span><i className="improved" /> faster</span>
        <span><i className="neutral" /> unchanged / uncertain</span>
        <span><i className="regressed" /> slower</span>
        <span><i className="structural" /> added / removed</span>
      </div>
    </section>
  )
}

function SelectionInspector({ row, metric, onAnalyze, onClear }: { row: PerformancePathDiff; metric: PerformanceMetric; onAnalyze: () => void; onClear: () => void }) {
  const result = row.metrics[metric]
  return <div className="panel pd-selection">
    <div className="pd-selection-name">
      <span className="micro-label">selected span</span>
      <strong title={row.path.join(' / ')}>{row.path.at(-1)}</strong>
      <span className="faint" title={row.path.join(' / ')}>{row.path.slice(0, -1).join(' / ') || 'root'}</span>
    </div>
    <span className="pd-selection-metric faint">{metricLabel(metric)}</span>
    <span className="mono-num">{formatNs(result.baselineNs)} → {formatNs(result.candidateNs)}</span>
    <strong className={`mono-num pd-direction ${result.absoluteChangeNs > 0 ? 'slower' : 'faster'}`}>{percent(result.relativeChange)}</strong>
    <Evidence row={row} metric={metric} />
    <button type="button" className="btn btn-primary btn-sm" onClick={onAnalyze}>analyze span</button>
    <button type="button" className="btn btn-ghost btn-sm" onClick={onClear} aria-label="clear selected span">×</button>
  </div>
}

function CostBars({ row, max }: { row: PerformancePathDiff; max: number }) {
  return <span className="pd-cost-bars" aria-hidden="true">
    <i className="baseline" style={{ width: `${row.baseline.meanNs / max * 100}%` }} />
    <i className="candidate" style={{ width: `${row.candidate.meanNs / max * 100}%` }} />
  </span>
}

function PathExplorer({ rows, metric, onMetricChange, selectedKey, onSelect }: {
  rows: PerformancePathDiff[]
  metric: PerformanceMetric
  onMetricChange: (metric: PerformanceMetric) => void
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'impact' | 'cost' | 'name'>('impact')
  const filtered = useMemo(() => {
    const match = query.trim().toLowerCase()
    const next = rows.filter((row) => match === '' || row.path.some((part) => part.toLowerCase().includes(match)))
    next.sort((a, b) => {
      if (sort === 'name') return a.path.join('/').localeCompare(b.path.join('/'))
      if (sort === 'cost') return Math.max(b.baseline.meanNs, b.candidate.meanNs) - Math.max(a.baseline.meanNs, a.candidate.meanNs)
      return Math.abs(b.metrics[metric].absoluteChangeNs) - Math.abs(a.metrics[metric].absoluteChangeNs)
    })
    return next
  }, [rows, query, sort, metric])
  const max = Math.max(1, ...filtered.map((row) => Math.max(row.baseline.meanNs, row.candidate.meanNs)))
  return (
    <section className="panel pd-explorer">
      <div className="pd-explorer-toolbar">
        <div><span className="panel-title">{metric === 'mean' ? 'path explorer' : `${metricLabel(metric)} changes`}</span><span className="faint"> {filtered.length} paths</span></div>
        <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="filter paths" aria-label="filter paths" />
        <MetricPicker value={metric} onChange={onMetricChange} />
        <span className="pd-sort">
          {(['impact', 'cost', 'name'] as const).map((value) => <button type="button" className={`chip ${sort === value ? 'active' : ''}`} key={value} onClick={() => setSort(value)}>{value}</button>)}
        </span>
        <span className="pd-cost-key faint"><i className="baseline" /> baseline <i className="candidate" /> candidate</span>
      </div>
      <div className="pd-path-cards">
        {filtered.slice(0, 2000).map((row) => <button type="button" className={`pd-path-card${selectedKey === row.key ? ' selected' : ''}`} key={row.key} onClick={() => onSelect(row.key)}>
          <span className="pd-path-card-top">
            <strong>{row.path.at(-1)}</strong>
            <span className={`pd-direction mono-num ${row.metrics[metric].absoluteChangeNs > 0 ? 'slower' : 'faster'}`}>{percent(row.metrics[metric].relativeChange)}</span>
          </span>
          <span className="pd-path-card-path faint" title={row.path.join(' / ')}>{row.path.slice(0, -1).join(' / ') || 'root'}</span>
          <CostBars row={row} max={max} />
          <span className="pd-path-card-values mono-num"><span>{formatNs(row.metrics[metric].baselineNs)}</span><span>→</span><span>{formatNs(row.metrics[metric].candidateNs)}</span><Evidence row={row} metric={metric} /></span>
        </button>)}
      </div>
      {filtered.length > 2000 && <div className="pd-cap faint">showing 2,000 of {filtered.length} paths</div>}
    </section>
  )
}

function RankedNodes({ title, nodes, max, tone }: { title: string; nodes: PerformanceInstanceDiff[]; max: number; tone: 'baseline' | 'candidate' }) {
  return <div className="pd-ranked-nodes">
    <div className="pd-ranked-nodes-head"><span className="panel-title">{title}</span><span className="faint">{nodes.length} nodes · slowest first</span></div>
    <div className="pd-ranked-node-list">{nodes.map((node, index) => {
      const value = tone === 'baseline' ? node.baselineMeanNs ?? 0 : node.candidateMeanNs ?? 0
      return <div className="pd-ranked-node" key={node.instanceId}>
        <span className="pd-node-rank mono-num">{index + 1}</span>
        <span className="pd-node-id" title={node.instanceId}>{shortId(node.instanceId)}</span>
        <span className="pd-node-bar"><i className={tone} style={{ width: `${value / max * 100}%` }} /></span>
        <strong className="mono-num">{formatNs(value)}</strong>
      </div>
    })}</div>
  </div>
}

function NodeExplorer({ rows, instances, onSelect }: { rows: PerformancePathDiff[]; instances: string[]; onSelect: (key: string) => void }) {
  const [query, setQuery] = useState('')
  const root = rows.find((row) => row.depth === 0) ?? null
  const match = query.trim().toLowerCase()
  const visible = instances.filter((id) => match === '' || id.toLowerCase().includes(match))
  const baselineNodes = (root?.instances ?? [])
    .filter((node) => node.baselineMeanNs !== null && (match === '' || node.instanceId.toLowerCase().includes(match)))
    .sort((a, b) => (b.baselineMeanNs ?? 0) - (a.baselineMeanNs ?? 0))
  const candidateNodes = (root?.instances ?? [])
    .filter((node) => node.candidateMeanNs !== null && (match === '' || node.instanceId.toLowerCase().includes(match)))
    .sort((a, b) => (b.candidateMeanNs ?? 0) - (a.candidateMeanNs ?? 0))
  const sharedNodes = (root?.instances ?? []).filter((node) => node.baselineMeanNs !== null && node.candidateMeanNs !== null)
  const unpaired = sharedNodes.length === 0 && baselineNodes.length > 0 && candidateNodes.length > 0
  const maxNode = Math.max(
    1,
    ...baselineNodes.map((node) => node.baselineMeanNs ?? 0),
    ...candidateNodes.map((node) => node.candidateMeanNs ?? 0),
  )
  return (
    <section className="panel pd-node-explorer">
      <div className="pd-explorer-toolbar">
        <div><span className="panel-title">node explorer</span><span className="faint"> {unpaired ? 'independent deployment populations' : `${visible.length} matched nodes`}</span></div>
        <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="find a node" aria-label="find a node" />
      </div>
      {unpaired ? <>
        {root !== null && <div className="pd-node-population-chart">
          <div><span className="panel-title">root latency distribution</span><span className="faint"> nodes are ranked independently because deployment identities differ</span></div>
          <CumulativeDistributionPlot
            ariaLabel="baseline and candidate empirical cumulative distributions"
            series={[
              { label: 'baseline', values: root.baselineValuesNs, tone: 'baseline' },
              { label: 'candidate', values: root.candidateValuesNs, tone: 'candidate' },
            ]}
          />
          <div className="pd-legend"><span className="baseline">baseline</span><span className="candidate">candidate</span></div>
        </div>}
        <div className="pd-node-populations">
          <RankedNodes title="baseline deployment" nodes={baselineNodes} max={maxNode} tone="baseline" />
          <RankedNodes title="candidate deployment" nodes={candidateNodes} max={maxNode} tone="candidate" />
        </div>
      </> : <div className="pd-node-cards">
        {visible.map((id) => {
          const rootStats = root?.instances.find((instance) => instance.instanceId === id)
          const changes = rows.flatMap((row) => {
            const stats = row.instances.find((instance) => instance.instanceId === id)
            if (stats?.baselineMeanNs === null || stats?.candidateMeanNs === null || stats === undefined) return []
            return [{ row, delta: stats.candidateMeanNs - stats.baselineMeanNs, relative: stats.relativeChange }]
          }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 4)
          const state = rootStats?.baselineMeanNs === null ? 'added' : rootStats?.candidateMeanNs === null ? 'removed' : 'present'
          return <article className="pd-node-card" key={id}>
            <div className="pd-node-card-head">
              <strong title={id}>{shortId(id)}</strong>
              <span className="faint">{state === 'present' ? `${rootStats?.baselineSamples ?? 0} → ${rootStats?.candidateSamples ?? 0} samples` : state}</span>
            </div>
            <div className="pd-node-root">
              <span>{rootStats?.baselineMeanNs === null || rootStats === undefined ? '—' : formatNs(rootStats.baselineMeanNs)}</span>
              <span className="faint">→</span>
              <span>{rootStats?.candidateMeanNs === null || rootStats === undefined ? '—' : formatNs(rootStats.candidateMeanNs)}</span>
              <strong className={`pd-direction ${rootStats?.relativeChange !== null && (rootStats?.relativeChange ?? 0) > 0 ? 'slower' : 'faster'}`}>{percent(rootStats?.relativeChange ?? null)}</strong>
            </div>
            <div className="pd-node-changes">
              {changes.length === 0 ? <span className="faint">no shared paths</span> : changes.map(({ row, delta, relative }) => <button type="button" key={row.key} onClick={() => onSelect(row.key)}>
                <span title={row.path.join(' / ')}>{row.path.at(-1)}</span>
                <span className={`mono-num pd-direction ${delta > 0 ? 'slower' : 'faster'}`}>{percent(relative)}</span>
              </button>)}
            </div>
          </article>
        })}
      </div>}
    </section>
  )
}

function usePlotWidth(initialWidth: number): [RefObject<SVGSVGElement | null>, number] {
  const ref = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(initialWidth)

  useLayoutEffect(() => {
    const svg = ref.current
    if (svg === null) return

    const resize = () => setWidth(Math.max(120, Math.round(svg.clientWidth)))
    resize()

    const observer = new ResizeObserver(resize)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}

function QuantileShiftPlot({ baseline, candidate }: { baseline: number[]; candidate: number[] }) {
  const [svgRef, width] = usePlotWidth(720)
  const percentiles = [0.5, 0.75, 0.9, 0.95, 0.99]
  const points = percentiles.map((percentile) => ({
    percentile,
    delta: quantileValue(candidate, percentile) - quantileValue(baseline, percentile),
  }))
  const left = 48
  const right = width - 12
  const top = 16
  const bottom = 126
  const maxMagnitude = Math.max(1, ...points.map((point) => Math.abs(point.delta)))
  const x = (percentile: number) => left + (percentile - 0.5) / 0.49 * (right - left)
  const y = (delta: number) => (top + bottom) / 2 - delta / maxMagnitude * (bottom - top) / 2
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.percentile)},${y(point.delta)}`).join(' ')

  return <svg ref={svgRef} className="pd-quantile-shift" viewBox={`0 0 ${width} 155`} role="img" aria-label="latency change by percentile">
    <line className="zero" x1={left} y1={y(0)} x2={right} y2={y(0)} />
    <text x={left - 8} y={top + 4} textAnchor="end">+{formatNs(maxMagnitude)}</text>
    <text x={left - 8} y={y(0) + 4} textAnchor="end">0</text>
    <text x={left - 8} y={bottom + 4} textAnchor="end">−{formatNs(maxMagnitude)}</text>
    <path d={path} />
    {points.map((point) => <g key={point.percentile}>
      <line className="tick" x1={x(point.percentile)} y1={bottom + 3} x2={x(point.percentile)} y2={bottom + 7} />
      <text x={x(point.percentile)} y={bottom + 20} textAnchor={point.percentile === 0.5 ? 'start' : point.percentile === 0.99 ? 'end' : 'middle'}>p{point.percentile * 100}</text>
      <circle className={`${point.delta > 0 ? 'slower' : 'faster'}${point.percentile === 0.99 && Math.min(baseline.length, candidate.length) < 200 ? ' sparse' : ''}`} cx={x(point.percentile)} cy={y(point.delta)} r="4">
        <title>p{point.percentile * 100}: {point.delta > 0 ? '+' : '−'}{formatNs(Math.abs(point.delta))}</title>
      </circle>
    </g>)}
  </svg>
}

function MetricCard({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'faster' | 'slower' }) {
  return <div className={`pd-metric-card${tone === undefined ? '' : ` ${tone}`}`}>
    <span className="micro-label">{label}</span>
    <strong className="mono-num">{value}</strong>
    <span className="faint">{note}</span>
  </div>
}

function PathDetails({ row, rows, metric, onMetricChange, onSelect, onClose }: { row: PerformancePathDiff; rows: PerformancePathDiff[]; metric: PerformanceMetric; onMetricChange: (metric: PerformanceMetric) => void; onSelect: (key: string) => void; onClose: () => void }) {
  const ancestors = row.path.slice(0, -1).map((_, index) => rows.find((candidate) =>
    candidate.path.length === index + 1 && candidate.path.every((part, partIndex) => part === row.path[partIndex]),
  )).filter((candidate): candidate is PerformancePathDiff => candidate !== undefined)
  const children = rows.filter((candidate) =>
    candidate.path.length === row.path.length + 1 && row.path.every((part, index) => candidate.path[index] === part),
  ).sort((a, b) => Math.max(b.baseline.meanNs, b.candidate.meanNs) - Math.max(a.baseline.meanNs, a.candidate.meanNs))
  const nodeChanges = row.instances
    .filter((instance) => instance.baselineMeanNs !== null || instance.candidateMeanNs !== null)
    .sort((a, b) => Math.abs(b.relativeChange ?? 0) - Math.abs(a.relativeChange ?? 0))
  const pairedNodes = nodeChanges.filter((instance) => instance.baselineMeanNs !== null && instance.candidateMeanNs !== null)
  const slowestBaseline = [...nodeChanges]
    .filter((instance) => instance.baselineMeanNs !== null)
    .sort((a, b) => (b.baselineMeanNs ?? 0) - (a.baselineMeanNs ?? 0))
    .slice(0, 5)
  const slowestCandidate = [...nodeChanges]
    .filter((instance) => instance.candidateMeanNs !== null)
    .sort((a, b) => (b.candidateMeanNs ?? 0) - (a.candidateMeanNs ?? 0))
    .slice(0, 5)
  const childMax = Math.max(1, ...children.map((child) => Math.max(child.baseline.meanNs, child.candidate.meanNs)))
  const selectedMetric = row.metrics[metric]
  return (
    <section className="panel pd-details">
      <div className="pd-details-header">
        <div>
          <span className="micro-label">selected span</span>
          <h2>{row.path.at(-1)}</h2>
          <div className="faint">{row.path.length === 1 ? 'root operation' : `${row.path.length - 1} callers · ${children.length} direct callees`}</div>
        </div>
        <MetricPicker value={metric} onChange={onMetricChange} />
        <Evidence row={row} metric={metric} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>×</button>
      </div>
      <div className="pd-details-body">
        <div className="pd-metrics">
          <MetricCard label={`baseline ${metricLabel(metric)}`} value={formatNs(selectedMetric.baselineNs)} note={`${row.baseline.samples} operations · mean ${formatNs(row.baseline.meanNs)}`} />
          <MetricCard label={`candidate ${metricLabel(metric)}`} value={formatNs(selectedMetric.candidateNs)} note={`${row.candidate.samples} operations · mean ${formatNs(row.candidate.meanNs)}`} />
          <MetricCard label="absolute change" value={`${selectedMetric.absoluteChangeNs > 0 ? '+' : '−'}${formatNs(Math.abs(selectedMetric.absoluteChangeNs))}`} note={`${percent(selectedMetric.relativeChange)} relative`} tone={selectedMetric.absoluteChangeNs > 0 ? 'slower' : 'faster'} />
          <MetricCard label="confidence" value={selectedMetric.reliable ? interval(selectedMetric) : 'sparse tail'} note={metric === 'mean' ? `adjusted p ${pValue(selectedMetric.adjustedP)} · Cliff δ ${row.effectSize?.toFixed(2) ?? '—'}` : selectedMetric.reliable ? 'order-statistic 95% interval' : 'needs more tail observations'} />
        </div>
        <section className="pd-call-stack">
          <nav className="pd-call-path" aria-label="call stack">
            <span className="micro-label">call stack</span>
            <div>{ancestors.map((ancestor) => <span key={ancestor.key}>
              <button type="button" onClick={() => onSelect(ancestor.key)}>{ancestor.path.at(-1)}</button><i>/</i>
            </span>)}<strong>{row.path.at(-1)}</strong></div>
          </nav>
          <div className="pd-callees">
            <div className="pd-section-heading"><span className="panel-title">direct callees</span><span className="faint">ranked by aggregate cost</span></div>
            {children.length === 0 ? <div className="faint pd-leaf">leaf span</div> : <div className="pd-callee-list">{children.slice(0, 12).map((child) => <button type="button" key={child.key} onClick={() => onSelect(child.key)}>
              <span className="pd-callee-name" title={child.path.join(' / ')}>{child.path.at(-1)}</span>
              <CostBars row={child} max={childMax} />
              <span className="mono-num">{formatNs(child.baseline.meanNs)} → {formatNs(child.candidate.meanNs)}</span>
              <strong className={`mono-num pd-direction ${child.absoluteChangeNs > 0 ? 'slower' : 'faster'}`}>{percent(child.relativeChange)}</strong>
            </button>)}</div>}
          </div>
        </section>
        <div className="pd-analysis-layout">
          <div className="pd-analysis-plots">
            <section className="pd-investigation-card pd-node-distribution-card">
              <div className="pd-section-heading"><span className="panel-title">node distribution</span><span className="faint">means · band = middle 50% · whisker = 10–90%</span></div>
              <NodeDistributionPlot
                ariaLabel="per-node mean duration distributions"
                lanes={[
                  {
                    label: 'baseline',
                    tone: 'baseline',
                    points: row.instances.flatMap((instance) => instance.baselineMeanNs === null ? [] : [{
                      id: instance.instanceId,
                      value: instance.baselineMeanNs,
                      colorIndex: colorIndexForService(instance.instanceId),
                    }]),
                  },
                  {
                    label: 'candidate',
                    tone: 'candidate',
                    points: row.instances.flatMap((instance) => instance.candidateMeanNs === null ? [] : [{
                      id: instance.instanceId,
                      value: instance.candidateMeanNs,
                      colorIndex: colorIndexForService(instance.instanceId),
                    }]),
                  },
                ]}
              />
            </section>
            <section className="pd-investigation-card pd-distribution pd-operation-distribution-card">
              <div className="pd-section-heading"><span className="panel-title">operation distribution</span><span className="faint">empirical cumulative distribution</span></div>
              <CumulativeDistributionPlot
                ariaLabel="baseline and candidate empirical cumulative distributions"
                series={[
                  { label: 'baseline', values: row.baselineValuesNs, tone: 'baseline' },
                  { label: 'candidate', values: row.candidateValuesNs, tone: 'candidate' },
                ]}
              />
              <div className="pd-legend"><span className="baseline">baseline</span><span className="candidate">candidate</span></div>
            </section>
            <section className="pd-investigation-card pd-quantile-card">
              <div className="pd-section-heading"><span className="panel-title">quantile shift</span><span className="faint">candidate − baseline · below zero is faster{Math.min(row.baseline.samples, row.candidate.samples) < 200 ? ' · p99 sparse' : ''}</span></div>
              <QuantileShiftPlot baseline={row.baselineValuesNs} candidate={row.candidateValuesNs} />
            </section>
          </div>
          <aside className="pd-analysis-sidebar">
            <section className="pd-investigation-card pd-behavior-card">
              <span className="panel-title">behavior changes</span>
              <dl className="pd-detail-stats">
                <dt>median</dt><dd>{formatNs(row.baseline.medianNs)} → {formatNs(row.candidate.medianNs)}</dd>
                <dt>MAD</dt><dd>{formatNs(row.baseline.madNs)} → {formatNs(row.candidate.madNs)}</dd>
                <dt>calls</dt><dd>{row.baselineCalls} → {row.candidateCalls}</dd>
                <dt>coverage</dt><dd>{percent(row.baselineCoverage, false)} → {percent(row.candidateCoverage, false)}</dd>
                <dt>errors</dt><dd>{row.baselineErrors} → {row.candidateErrors}</dd>
                <dt>outliers</dt><dd>{row.baseline.outliers} → {row.candidate.outliers}</dd>
              </dl>
            </section>
            <section className="pd-investigation-card pd-node-impact">
              <div className="pd-section-heading"><span className="panel-title">{pairedNodes.length > 0 ? 'largest node shifts' : 'slowest nodes'}</span><span className="faint">{nodeChanges.length} observations</span></div>
              {pairedNodes.length > 0 ? <div className="pd-node-impact-list">{pairedNodes.slice(0, 12).map((instance) => <div key={instance.instanceId}>
                <i style={{ background: instanceColorVar(colorIndexForService(instance.instanceId)) }} />
                <span title={instance.instanceId}>{shortId(instance.instanceId)}</span>
                <span className="faint mono-num">{formatNs(instance.baselineMeanNs ?? 0)} → {formatNs(instance.candidateMeanNs ?? 0)}</span>
                <strong className={`pd-direction mono-num ${(instance.relativeChange ?? 0) > 0 ? 'slower' : 'faster'}`}>{percent(instance.relativeChange)}</strong>
              </div>)}</div> : <div className="pd-unpaired-impact">
                <div><span className="micro-label">baseline</span>{slowestBaseline.map((instance) => <span key={instance.instanceId}><span title={instance.instanceId}>{shortId(instance.instanceId)}</span><strong>{formatNs(instance.baselineMeanNs ?? 0)}</strong></span>)}</div>
                <div><span className="micro-label">candidate</span>{slowestCandidate.map((instance) => <span key={instance.instanceId}><span title={instance.instanceId}>{shortId(instance.instanceId)}</span><strong>{formatNs(instance.candidateMeanNs ?? 0)}</strong></span>)}</div>
              </div>}
            </section>
          </aside>
        </div>
      </div>
    </section>
  )
}

export default function PerformanceDiffPage({
  baselineQuery,
  candidateQuery,
  capturedBaseline,
  capturedCandidate,
  threshold,
  view,
  selectedPath,
  client,
  loadQuery,
  onCaptureBaseline,
  onCaptureCandidate,
  onRouteChange,
}: PerformanceDiffPageProps) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [metric, setMetric] = useState<PerformanceMetric>('mean')
  const [pickerSide, setPickerSide] = useState<'baseline' | 'candidate' | null>(null)
  const baselineLive = useQuery({
    queryKey: ['performance-source', baselineQuery],
    queryFn: () => loadQuery(baselineQuery!),
    enabled: baselineQuery !== null,
  })
  const candidateLive = useQuery({
    queryKey: ['performance-source', candidateQuery],
    queryFn: () => loadQuery(candidateQuery!),
    enabled: candidateQuery !== null,
  })
  const baseline = useMemo<PerformanceSource | null>(() => {
    if (baselineQuery !== null) {
      return { kind: 'query', query: baselineQuery, label: compareQueryLabel(baselineQuery) }
    }
    return baselineQuery === null ? capturedBaseline : null
  }, [baselineQuery, capturedBaseline])
  const candidate = useMemo<PerformanceSource | null>(() => {
    if (candidateQuery !== null) {
      return { kind: 'query', query: candidateQuery, label: compareQueryLabel(candidateQuery) }
    }
    return candidateQuery === null ? capturedCandidate : null
  }, [candidateQuery, capturedCandidate])
  const baselineModel: TraceModel | null = baselineQuery !== null
    ? baselineLive.data ?? null
    : baseline?.kind !== 'query' && baseline !== null ? baseline.model : null
  const candidateModel: TraceModel | null = candidateQuery !== null
    ? candidateLive.data ?? null
    : candidate?.kind !== 'query' && candidate !== null ? candidate.model : null
  const analysis = usePerformanceAnalysis(
    view === 'latency' ? null : baselineModel,
    view === 'latency' ? null : candidateModel,
    threshold,
  )
  const selected = analysis.result?.paths.find((row) => row.key === selectedPath) ?? null

  const route = (patch: Partial<Parameters<PerformanceDiffPageProps['onRouteChange']>[0]>) =>
    onRouteChange({ baselineQuery, candidateQuery, threshold, view, selectedPath, ...patch })

  const chooseSource = (side: 'baseline' | 'candidate', source: PerformanceSource) => {
    const query = source.kind === 'query' ? source.query : null
    if (side === 'baseline') {
      onCaptureBaseline(source.kind === 'query' ? null : source)
      route({ baselineQuery: query, selectedPath: null })
    } else {
      onCaptureCandidate(source.kind === 'query' ? null : source)
      route({ candidateQuery: query, selectedPath: null })
    }
    setPickerSide(null)
  }

  return (
    <div className="pd-page">
      {(baselineModel === null || candidateModel === null) && <div className="pd-source-setup">
        <div className="pd-source-setup-copy">
          <strong>Choose a baseline and candidate</strong>
          <span className="faint">Either side can be a searched comparison or an export.</span>
        </div>
        <div className="pd-sources">
        <SourceCard
          side="baseline"
          source={baseline}
          loading={baselineLive.isLoading}
          error={baselineLive.error === null ? null : String(baselineLive.error)}
          onChoose={() => setPickerSide('baseline')}
          onClear={() => {
            onCaptureBaseline(null)
            route({ baselineQuery: null })
          }}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm pd-swap"
          disabled={baseline === null && candidate === null}
          onClick={() => {
            onCaptureBaseline(candidate?.kind !== 'query' ? candidate : null)
            onCaptureCandidate(baseline?.kind !== 'query' ? baseline : null)
            route({
              baselineQuery: candidate?.kind === 'query' ? candidate.query : null,
              candidateQuery: baseline?.kind === 'query' ? baseline.query : null,
            })
          }}
          title="swap baseline and candidate"
        >
          ⇄
        </button>
        <SourceCard
          side="candidate"
          source={candidate}
          loading={candidateLive.isLoading}
          error={candidateLive.error === null ? null : String(candidateLive.error)}
          onChoose={() => setPickerSide('candidate')}
          onClear={() => {
            onCaptureCandidate(null)
            route({ candidateQuery: null })
          }}
        />
        </div>
      </div>}
      {baselineModel === null || candidateModel === null ? (
        null
      ) : view === 'latency' ? (
        <div className="pd-workspace">
          <div className="pd-content">
            <div className="pd-controls">
              <span className="pd-view-tabs">
                {(['overview', 'latency', 'paths', 'nodes'] as const).map((item) => (
                  <button type="button" key={item} className={`chip ${view === item ? 'active' : ''}`} onClick={() => route({ view: item })}>
                    {item === 'paths' ? 'hot paths' : item === 'latency' ? 'latency path' : item}
                  </button>
                ))}
              </span>
            </div>
            <LatencyPathDiff
              baseline={baselineModel}
              candidate={candidateModel}
              onSelectPath={(key) => route({ view: 'paths', selectedPath: key })}
            />
          </div>
        </div>
      ) : analysis.loading ? (
        <div className="empty-state pd-empty"><span className="spinner" /> analyzing 10,000 resamples…</div>
      ) : analysis.error !== null ? (
        <div className="empty-state pd-empty pd-analysis-error">analysis failed: {analysis.error}</div>
      ) : analysis.result !== null ? (
        <div className="pd-workspace">
          {detailsOpen && selected !== null ? (
            <PathDetails
              row={selected}
              rows={analysis.result.paths}
              metric={metric}
              onMetricChange={setMetric}
              onSelect={(key) => route({ selectedPath: key })}
              onClose={() => setDetailsOpen(false)}
            />
          ) : <div className="pd-content">
            <div className="pd-controls">
              <span className="pd-view-tabs">
                {(['overview', 'latency', 'paths', 'nodes'] as const).map((item) => (
                  <button type="button" key={item} className={`chip ${view === item ? 'active' : ''}`} onClick={() => route({ view: item })}>
                    {item === 'paths' ? 'hot paths' : item === 'latency' ? 'latency path' : item}
                  </button>
                ))}
              </span>
              {analysis.result.root !== null && <ComparisonSummary row={analysis.result.root} diff={analysis.result} metric={metric} />}
              <span className="pd-threshold">
                <span className="faint">noise threshold</span>
                {[0.01, 0.02, 0.05, 0.1].map((value) => (
                  <button type="button" key={value} className={`chip ${threshold === value ? 'active' : ''}`} onClick={() => route({ threshold: value })}>{value * 100}%</button>
                ))}
              </span>
            </div>
            {analysis.result.warning !== null && <div className={analysis.result.inferential && !analysis.result.warning.startsWith('Low sample size') ? 'pd-notice' : 'pd-warning'}>{analysis.result.warning}</div>}
            {view === 'overview' && (
              <ImpactTree rows={analysis.result.paths} metric={metric} onMetricChange={setMetric} selectedKey={selectedPath} onSelect={(key) => route({ selectedPath: key })} />
            )}
            {view === 'paths' && <PathExplorer rows={analysis.result.paths} metric={metric} onMetricChange={setMetric} selectedKey={selectedPath} onSelect={(key) => route({ selectedPath: key })} />}
            {view === 'nodes' && (
              <NodeExplorer
                rows={analysis.result.paths}
                instances={[...new Set([...analysis.result.baselineInstances, ...analysis.result.candidateInstances])]}
                onSelect={(key) => route({ selectedPath: key })}
              />
            )}
            {selected !== null && <SelectionInspector row={selected} metric={metric} onAnalyze={() => setDetailsOpen(true)} onClear={() => route({ selectedPath: null })} />}
          </div>}
        </div>
      ) : (
        <div className="empty-state pd-empty">no performance data</div>
      )}
      {pickerSide !== null && <PerformanceSourceModal
        side={pickerSide}
        client={client}
        initialSpanName={sourceSpanName(pickerSide === 'baseline' ? candidate : baseline)}
        onSelect={(source) => chooseSource(pickerSide, source)}
        onClose={() => setPickerSide(null)}
      />}
    </div>
  )
}
