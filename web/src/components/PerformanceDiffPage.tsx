import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  PerformanceDiffPageProps,
  PerformanceDiff,
  PerformanceInstanceDiff,
  PerformancePathDiff,
  PerformanceSource,
  TraceModel,
} from '../lib/model'
import { importTraceExport } from '../lib/export'
import { formatNs, shortId } from '../lib/format'
import './PerformanceDiffPage.css'

function queryLabel(query: string): string {
  const params = new URLSearchParams(query)
  const name = params.get('name')?.trim() || 'comparison'
  const attr = params.getAll('attr')[0]
  return attr === undefined ? name : `${name} · ${attr}`
}

function normalizeQuery(input: string): string | null {
  const value = input.trim()
  if (value === '') return null
  const hashMarker = '#/compare?'
  const hashAt = value.indexOf(hashMarker)
  if (hashAt >= 0) return value.slice(hashAt + hashMarker.length)
  const apiMarker = '/api/v1/compare?'
  const apiAt = value.indexOf(apiMarker)
  if (apiAt >= 0) return value.slice(apiAt + apiMarker.length)
  return value.startsWith('?') ? value.slice(1) : value
}

async function readExport(file: File): Promise<PerformanceSource> {
  let value: unknown
  try {
    value = JSON.parse(await file.text())
  } catch {
    throw new Error(`${file.name} is not valid JSON`)
  }
  return { kind: 'export', label: file.name, model: importTraceExport(value) }
}

interface SourceCardProps {
  side: 'baseline' | 'candidate'
  source: PerformanceSource | null
  loading: boolean
  error: string | null
  onQuery: (query: string) => void
  onFile: (source: PerformanceSource) => void
  onClear: () => void
}

function SourceCard({ side, source, loading, error, onQuery, onFile, onClear }: SourceCardProps) {
  const [draft, setDraft] = useState('')
  const [fileError, setFileError] = useState<string | null>(null)
  const chooseFile = async (file: File | undefined) => {
    if (file === undefined) return
    setFileError(null)
    try {
      onFile(await readExport(file))
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err))
    }
  }
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
          {source.kind === 'export' && (
            <span className="faint mono-num">
              {source.model.instances.length} nodes · {source.model.instances.reduce((sum, instance) => sum + instance.rootSpans.length, 0)} operations
            </span>
          )}
        </div>
      ) : (
        <div className="pd-source-empty">
          <label className="pd-upload">
            <span>upload trace export</span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => void chooseFile(event.target.files?.[0])}
            />
          </label>
          <span className="faint pd-or">or</span>
          <form
            className="pd-query-form"
            onSubmit={(event) => {
              event.preventDefault()
              const query = normalizeQuery(draft)
              if (query !== null) onQuery(query)
            }}
          >
            <input
              className="input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="paste compare URL or query"
              aria-label={`${side} compare URL`}
            />
            <button className="btn btn-sm" type="submit" disabled={draft.trim() === ''}>use</button>
          </form>
        </div>
      )}
      {(error ?? fileError) !== null && <div className="pd-source-error">{error ?? fileError}</div>}
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

function interval(row: PerformancePathDiff): string {
  if (row.relativeInterval === null) return '—'
  return `[${percent(row.relativeInterval.low)}, ${percent(row.relativeInterval.high)}]`
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

function Evidence({ row }: { row: PerformancePathDiff }) {
  const arrow = row.evidence === 'regressed' ? '↑' : row.evidence === 'improved' ? '↓' : ''
  return <span className={`pd-evidence pd-${row.evidence}`}>{arrow} {row.evidence.replace('-', ' ')}</span>
}

function ComparisonSummary({ row, diff }: { row: PerformancePathDiff; diff: PerformanceDiff }) {
  return (
    <div className="pd-summary-line">
      <strong title={row.path.join(' / ')}>{row.path.at(-1)}</strong>
      <span className="mono-num">{formatNs(row.baseline.meanNs)} → {formatNs(row.candidate.meanNs)}</span>
      <strong className={`mono-num pd-direction ${row.absoluteChangeNs > 0 ? 'slower' : 'faster'}`}>{percent(row.relativeChange)}</strong>
      <span className="faint mono-num">95% {interval(row)}</span>
      <Evidence row={row} />
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
        const childScale = cellWidth / weight(row)
        const childrenWidth = descendants.reduce((sum, child) => sum + weight(child) * childScale, 0)
        const containedWidth = Math.min(cellWidth, childrenWidth)
        place(descendants, cursor, containedWidth, depth + 1)
      }
      cursor += cellWidth
    }
  }
  place(roots, 0, 100, 0)
  return { cells, depth: Math.max(0, ...cells.map((cell) => cell.depth)) }
}

function frameBackground(row: PerformancePathDiff): string | undefined {
  if (row.evidence === 'added' || row.evidence === 'removed') return undefined
  if (row.relativeChange === null || row.relativeChange === 0) return undefined
  const token = row.relativeChange > 0 ? '--perf-regressed' : '--perf-improved'
  const strength = Math.min(76, 18 + Math.abs(row.relativeChange) * 110)
  return `color-mix(in srgb, var(${token}) ${strength}%, var(--surface-hover))`
}

function ImpactTree({ rows, selectedKey, onSelect }: { rows: PerformancePathDiff[]; selectedKey: string | null; onSelect: (key: string) => void }) {
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const layout = useMemo(() => layoutFlame(rows, focusedKey), [rows, focusedKey])
  const match = query.trim().toLowerCase()
  const focused = focusedKey === null ? null : rows.find((row) => row.key === focusedKey) ?? null
  return (
    <section className="panel pd-flame-panel">
      <div className="pd-flame-toolbar">
        <div>
          <span className="panel-title">aggregate differential call tree</span>
          <span className="pd-flame-help faint">merged flamegraph · width = aggregate cost · color = performance change · double-click = focus</span>
        </div>
        <div className="pd-flame-actions">
          <input className="input pd-flame-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="find a span" aria-label="find a span" />
          {focused !== null && <button type="button" className="btn btn-sm" onClick={() => setFocusedKey(null)}>reset focus</button>}
        </div>
      </div>
      {focused !== null && <div className="pd-focus-path"><span className="faint">focused</span> {focused.path.join(' / ')}</div>}
      <div className="pd-flame-viewport">
        <div className="pd-flame" style={{ height: `${Math.max(150, (layout.depth + 1) * 20 + 4)}px` }}>
          {layout.cells.map((cell) => {
            const matching = match !== '' && cell.row.path.some((part) => part.toLowerCase().includes(match))
            const dimmed = match !== '' && !matching
            return <button
              type="button"
              key={cell.row.key}
              className={`pd-frame pd-${cell.row.evidence}${selectedKey === cell.row.key ? ' selected' : ''}${matching ? ' matching' : ''}${dimmed ? ' dimmed' : ''}`}
              style={{
                left: `calc(${cell.left}% + 1px)`,
                width: `max(2px, calc(${cell.width}% - 2px))`,
                top: `${cell.depth * 20 + 2}px`,
                background: frameBackground(cell.row),
              }}
              onClick={() => onSelect(cell.row.key)}
              onDoubleClick={() => setFocusedKey(cell.row.key)}
              title={`${cell.row.path.join(' / ')}\n${formatNs(cell.row.baseline.meanNs)} → ${formatNs(cell.row.candidate.meanNs)} (${percent(cell.row.relativeChange)})`}
            >
              <span className="pd-frame-name">{cell.row.path.at(-1)}</span>
              <span className="pd-frame-delta mono-num">{percent(cell.row.relativeChange)}</span>
            </button>
          })}
        </div>
      </div>
      <div className="pd-flame-legend">
        <span className="pd-elided">all frames shown</span>
        <span><i className="improved" /> faster</span>
        <span><i className="neutral" /> unchanged / uncertain</span>
        <span><i className="regressed" /> slower</span>
        <span><i className="structural" /> added / removed</span>
      </div>
    </section>
  )
}

function SelectionInspector({ row, onAnalyze, onClear }: { row: PerformancePathDiff; onAnalyze: () => void; onClear: () => void }) {
  return <div className="panel pd-selection">
    <div className="pd-selection-name">
      <span className="micro-label">selected span</span>
      <strong title={row.path.join(' / ')}>{row.path.at(-1)}</strong>
      <span className="faint" title={row.path.join(' / ')}>{row.path.slice(0, -1).join(' / ') || 'root'}</span>
    </div>
    <span className="mono-num">{formatNs(row.baseline.meanNs)} → {formatNs(row.candidate.meanNs)}</span>
    <strong className={`mono-num pd-direction ${row.absoluteChangeNs > 0 ? 'slower' : 'faster'}`}>{percent(row.relativeChange)}</strong>
    <Evidence row={row} />
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

function PathExplorer({ rows, selectedKey, onSelect }: { rows: PerformancePathDiff[]; selectedKey: string | null; onSelect: (key: string) => void }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'impact' | 'cost' | 'name'>('impact')
  const filtered = useMemo(() => {
    const match = query.trim().toLowerCase()
    const next = rows.filter((row) => match === '' || row.path.some((part) => part.toLowerCase().includes(match)))
    next.sort((a, b) => {
      if (sort === 'name') return a.path.join('/').localeCompare(b.path.join('/'))
      if (sort === 'cost') return Math.max(b.baseline.meanNs, b.candidate.meanNs) - Math.max(a.baseline.meanNs, a.candidate.meanNs)
      return Math.abs(b.absoluteChangeNs) - Math.abs(a.absoluteChangeNs)
    })
    return next
  }, [rows, query, sort])
  const max = Math.max(1, ...filtered.map((row) => Math.max(row.baseline.meanNs, row.candidate.meanNs)))
  return (
    <section className="panel pd-explorer">
      <div className="pd-explorer-toolbar">
        <div><span className="panel-title">path explorer</span><span className="faint"> {filtered.length} paths</span></div>
        <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="filter paths" aria-label="filter paths" />
        <span className="pd-sort">
          {(['impact', 'cost', 'name'] as const).map((value) => <button type="button" className={`chip ${sort === value ? 'active' : ''}`} key={value} onClick={() => setSort(value)}>{value}</button>)}
        </span>
        <span className="pd-cost-key faint"><i className="baseline" /> baseline <i className="candidate" /> candidate</span>
      </div>
      <div className="pd-path-cards">
        {filtered.slice(0, 2000).map((row) => <button type="button" className={`pd-path-card${selectedKey === row.key ? ' selected' : ''}`} key={row.key} onClick={() => onSelect(row.key)}>
          <span className="pd-path-card-top">
            <strong>{row.path.at(-1)}</strong>
            <span className={`pd-direction mono-num ${row.absoluteChangeNs > 0 ? 'slower' : 'faster'}`}>{percent(row.relativeChange)}</span>
          </span>
          <span className="pd-path-card-path faint" title={row.path.join(' / ')}>{row.path.slice(0, -1).join(' / ') || 'root'}</span>
          <CostBars row={row} max={max} />
          <span className="pd-path-card-values mono-num"><span>{formatNs(row.baseline.meanNs)}</span><span>→</span><span>{formatNs(row.candidate.meanNs)}</span><Evidence row={row} /></span>
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
          <Ecdf baseline={root.baselineValuesNs} candidate={root.candidateValuesNs} />
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

function Ecdf({ baseline, candidate }: { baseline: number[]; candidate: number[] }) {
  const all = [...baseline, ...candidate]
  const max = Math.max(1, ...all)
  const left = 48
  const right = 428
  const top = 12
  const bottom = 156
  const x = (value: number) => left + value / max * (right - left)
  const y = (fraction: number) => bottom - fraction * (bottom - top)
  const line = (values: number[]) => {
    const ordered = [...values].sort((a, b) => a - b)
    let path = `M${left},${bottom}`
    ordered.forEach((value, index) => {
      const nextX = x(value).toFixed(1)
      const nextY = y((index + 1) / ordered.length).toFixed(1)
      path += ` H${nextX} V${nextY}`
    })
    return path
  }
  return (
    <svg className="pd-ecdf" viewBox="0 0 440 185" role="img" aria-label="baseline and candidate empirical cumulative distributions">
      <line className="axis" x1={left} y1={bottom} x2={right} y2={bottom} />
      <line className="axis" x1={left} y1={top} x2={left} y2={bottom} />
      {[0, 0.5, 1].map((fraction) => <g key={`y-${fraction}`}>
        <line className="grid" x1={left} y1={y(fraction)} x2={right} y2={y(fraction)} />
        <text x={left - 8} y={y(fraction) + 3} textAnchor="end">{fraction * 100}%</text>
      </g>)}
      {[0, 0.5, 1].map((fraction) => <g key={`x-${fraction}`}>
        <line className="tick" x1={x(max * fraction)} y1={bottom} x2={x(max * fraction)} y2={bottom + 4} />
        <text x={x(max * fraction)} y={bottom + 17} textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}>{formatNs(max * fraction)}</text>
      </g>)}
      <path className="baseline" d={line(baseline)} />
      <path className="candidate" d={line(candidate)} />
    </svg>
  )
}

function MetricCard({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'faster' | 'slower' }) {
  return <div className={`pd-metric-card${tone === undefined ? '' : ` ${tone}`}`}>
    <span className="micro-label">{label}</span>
    <strong className="mono-num">{value}</strong>
    <span className="faint">{note}</span>
  </div>
}

function PathDetails({ row, rows, onSelect, onClose }: { row: PerformancePathDiff; rows: PerformancePathDiff[]; onSelect: (key: string) => void; onClose: () => void }) {
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
  return (
    <section className="panel pd-details">
      <div className="pd-details-header">
        <div>
          <span className="micro-label">selected span</span>
          <h2>{row.path.at(-1)}</h2>
          <div className="pd-breadcrumb">{row.path.slice(0, -1).join(' / ') || 'root'}</div>
        </div>
        <Evidence row={row} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>×</button>
      </div>
      <div className="pd-details-body">
        <div className="pd-metrics">
          <MetricCard label="baseline mean" value={formatNs(row.baseline.meanNs)} note={`${row.baseline.samples} operations · p95 ${formatNs(row.baseline.p95Ns)}`} />
          <MetricCard label="candidate mean" value={formatNs(row.candidate.meanNs)} note={`${row.candidate.samples} operations · p95 ${formatNs(row.candidate.p95Ns)}`} />
          <MetricCard label="absolute change" value={`${row.absoluteChangeNs > 0 ? '+' : '−'}${formatNs(Math.abs(row.absoluteChangeNs))}`} note={`${percent(row.relativeChange)} relative`} tone={row.absoluteChangeNs > 0 ? 'slower' : 'faster'} />
          <MetricCard label="confidence" value={interval(row)} note={`p ${pValue(row.rawP)} · adjusted ${pValue(row.adjustedP)} · Cliff δ ${row.effectSize?.toFixed(2) ?? '—'}`} />
        </div>
        <div className="pd-sandwich">
          <div className="pd-context-stack">
            <span className="micro-label">callers</span>
            {ancestors.length === 0 ? <span className="faint">root span</span> : ancestors.map((ancestor) => <button type="button" key={ancestor.key} onClick={() => onSelect(ancestor.key)}><span>{ancestor.path.at(-1)}</span><span>{percent(ancestor.relativeChange)}</span></button>)}
          </div>
          <div className="pd-context-current"><strong>{row.path.at(-1)}</strong><span>{formatNs(row.baseline.meanNs)} → {formatNs(row.candidate.meanNs)}</span></div>
          <div className="pd-context-stack">
            <span className="micro-label">callees</span>
            {children.length === 0 ? <span className="faint">leaf span</span> : children.slice(0, 12).map((child) => <button type="button" key={child.key} onClick={() => onSelect(child.key)}><span>{child.path.at(-1)}</span><span>{percent(child.relativeChange)}</span></button>)}
          </div>
        </div>
        <div className="pd-investigation-grid">
          <div className="pd-investigation-card pd-distribution">
            <div><span className="panel-title">operation distribution</span><span className="faint"> empirical cumulative distribution</span></div>
            <Ecdf baseline={row.baselineValuesNs} candidate={row.candidateValuesNs} />
            <div className="pd-legend"><span className="baseline">baseline</span><span className="candidate">candidate</span></div>
          </div>
          <div className="pd-investigation-card">
            <span className="panel-title">behavior changes</span>
            <dl className="pd-detail-stats">
              <dt>median</dt><dd>{formatNs(row.baseline.medianNs)} → {formatNs(row.candidate.medianNs)}</dd>
              <dt>MAD</dt><dd>{formatNs(row.baseline.madNs)} → {formatNs(row.candidate.madNs)}</dd>
              <dt>calls</dt><dd>{row.baselineCalls} → {row.candidateCalls}</dd>
              <dt>coverage</dt><dd>{percent(row.baselineCoverage, false)} → {percent(row.candidateCoverage, false)}</dd>
              <dt>errors</dt><dd>{row.baselineErrors} → {row.candidateErrors}</dd>
              <dt>outliers</dt><dd>{row.baseline.outliers} → {row.candidate.outliers}</dd>
            </dl>
          </div>
          <div className="pd-investigation-card pd-node-impact">
            <div><span className="panel-title">{pairedNodes.length > 0 ? 'node impact' : 'slowest nodes'}</span><span className="faint"> {nodeChanges.length} observations</span></div>
            {pairedNodes.length > 0 ? <div className="pd-node-impact-list">{pairedNodes.slice(0, 20).map((instance) => <div key={instance.instanceId}>
              <span title={instance.instanceId}>{shortId(instance.instanceId)}</span>
              <span className="faint mono-num">{formatNs(instance.baselineMeanNs ?? 0)} → {formatNs(instance.candidateMeanNs ?? 0)}</span>
              <strong className={`pd-direction mono-num ${(instance.relativeChange ?? 0) > 0 ? 'slower' : 'faster'}`}>{percent(instance.relativeChange)}</strong>
            </div>)}</div> : <div className="pd-unpaired-impact">
              <div><span className="micro-label">baseline</span>{slowestBaseline.map((instance) => <span key={instance.instanceId}><span title={instance.instanceId}>{shortId(instance.instanceId)}</span><strong>{formatNs(instance.baselineMeanNs ?? 0)}</strong></span>)}</div>
              <div><span className="micro-label">candidate</span>{slowestCandidate.map((instance) => <span key={instance.instanceId}><span title={instance.instanceId}>{shortId(instance.instanceId)}</span><strong>{formatNs(instance.candidateMeanNs ?? 0)}</strong></span>)}</div>
            </div>}
          </div>
        </div>
      </div>
    </section>
  )
}

export default function PerformanceDiffPage({
  baselineQuery,
  candidateQuery,
  capturedBaseline,
  threshold,
  view,
  selectedPath,
  loadQuery,
  onCaptureBaseline,
  onRouteChange,
}: PerformanceDiffPageProps) {
  const [candidateUpload, setCandidateUpload] = useState<PerformanceSource | null>(null)
  const [sourcesExpanded, setSourcesExpanded] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
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
      return { kind: 'query', query: baselineQuery, label: queryLabel(baselineQuery) }
    }
    return baselineQuery === null ? capturedBaseline : null
  }, [baselineQuery, capturedBaseline])
  const candidate = useMemo<PerformanceSource | null>(() => {
    if (candidateQuery !== null) {
      return { kind: 'query', query: candidateQuery, label: queryLabel(candidateQuery) }
    }
    return candidateQuery === null ? candidateUpload : null
  }, [candidateQuery, candidateUpload])
  const baselineModel: TraceModel | null = baselineQuery !== null
    ? baselineLive.data ?? null
    : baseline?.kind === 'export' ? baseline.model : null
  const candidateModel: TraceModel | null = candidateQuery !== null
    ? candidateLive.data ?? null
    : candidate?.kind === 'export' ? candidate.model : null
  const analysis = usePerformanceAnalysis(baselineModel, candidateModel, threshold)
  const selected = analysis.result?.paths.find((row) => row.key === selectedPath) ?? null

  const route = (patch: Partial<Parameters<PerformanceDiffPageProps['onRouteChange']>[0]>) =>
    onRouteChange({ baselineQuery, candidateQuery, threshold, view, selectedPath, ...patch })

  return (
    <div className="pd-page">
      {baselineModel !== null && candidateModel !== null && !sourcesExpanded ? (
        <div className="panel pd-compare-bar">
          <span className="pd-compare-side"><span className="micro-label">baseline</span><strong title={baseline?.label}>{baseline?.label}</strong></span>
          <span className="pd-compare-arrow">→</span>
          <span className="pd-compare-side"><span className="micro-label">candidate</span><strong title={candidate?.label}>{candidate?.label}</strong></span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSourcesExpanded(true)}>change inputs</button>
        </div>
      ) : <>
      <div className="pd-sources">
        <SourceCard
          side="baseline"
          source={baseline}
          loading={baselineLive.isLoading}
          error={baselineLive.error === null ? null : String(baselineLive.error)}
          onQuery={(query) => route({ baselineQuery: query })}
          onFile={(source) => {
            onCaptureBaseline(source)
            route({ baselineQuery: null })
          }}
          onClear={() => {
            onCaptureBaseline(null)
            route({ baselineQuery: null })
          }}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm pd-swap"
          disabled={baselineModel === null || candidateModel === null}
          onClick={() => {
            if (baselineQuery !== null && candidateQuery !== null) {
              route({ baselineQuery: candidateQuery, candidateQuery: baselineQuery })
            } else if (baseline?.kind === 'export' && candidate?.kind === 'export') {
              onCaptureBaseline(candidate)
              setCandidateUpload(baseline)
            } else if (baselineQuery !== null && candidate?.kind === 'export') {
              onCaptureBaseline(candidate)
              setCandidateUpload(null)
              route({ baselineQuery: null, candidateQuery: baselineQuery })
            } else if (baseline?.kind === 'export' && candidateQuery !== null) {
              onCaptureBaseline(null)
              setCandidateUpload(baseline)
              route({ baselineQuery: candidateQuery, candidateQuery: null })
            }
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
          onQuery={(query) => {
            setCandidateUpload(null)
            route({ candidateQuery: query })
          }}
          onFile={(source) => {
            setCandidateUpload(source)
            route({ candidateQuery: null })
          }}
          onClear={() => {
            setCandidateUpload(null)
            route({ candidateQuery: null })
          }}
        />
      </div>
      {sourcesExpanded && baselineModel !== null && candidateModel !== null && (
        <button type="button" className="btn btn-ghost btn-sm pd-inputs-done" onClick={() => setSourcesExpanded(false)}>
          done changing inputs
        </button>
      )}
      </>}
      {baselineModel === null || candidateModel === null ? (
        <div className="empty-state pd-empty">
          Choose a baseline and candidate. Either side can be a searched comparison or an export.
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
              onSelect={(key) => route({ selectedPath: key })}
              onClose={() => setDetailsOpen(false)}
            />
          ) : <div className="pd-content">
            <div className="pd-controls">
              <span className="pd-view-tabs">
                {(['overview', 'paths', 'nodes'] as const).map((item) => (
                  <button type="button" key={item} className={`chip ${view === item ? 'active' : ''}`} onClick={() => route({ view: item })}>{item === 'paths' ? 'hot paths' : item}</button>
                ))}
              </span>
              {analysis.result.root !== null && <ComparisonSummary row={analysis.result.root} diff={analysis.result} />}
              <span className="pd-threshold">
                <span className="faint">noise threshold</span>
                {[0.01, 0.02, 0.05, 0.1].map((value) => (
                  <button type="button" key={value} className={`chip ${threshold === value ? 'active' : ''}`} onClick={() => route({ threshold: value })}>{value * 100}%</button>
                ))}
              </span>
            </div>
            {analysis.result.warning !== null && <div className={analysis.result.comparisonMode === 'unpaired' ? 'pd-notice' : 'pd-warning'}>{analysis.result.warning}</div>}
            {view === 'overview' && (
              <ImpactTree rows={analysis.result.paths} selectedKey={selectedPath} onSelect={(key) => route({ selectedPath: key })} />
            )}
            {view === 'paths' && <PathExplorer rows={analysis.result.paths} selectedKey={selectedPath} onSelect={(key) => route({ selectedPath: key })} />}
            {view === 'nodes' && (
              <NodeExplorer
                rows={analysis.result.paths}
                instances={[...new Set([...analysis.result.baselineInstances, ...analysis.result.candidateInstances])]}
                onSelect={(key) => route({ selectedPath: key })}
              />
            )}
            {selected !== null && <SelectionInspector row={selected} onAnalyze={() => setDetailsOpen(true)} onClear={() => route({ selectedPath: null })} />}
          </div>}
        </div>
      ) : (
        <div className="empty-state pd-empty">no performance data</div>
      )}
    </div>
  )
}
