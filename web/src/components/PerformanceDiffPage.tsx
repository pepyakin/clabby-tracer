import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  PerformanceDiffPageProps,
  PerformanceDiff,
  PerformancePathDiff,
  PerformanceSource,
  TraceModel,
} from '../lib/model'
import { importTraceExport } from '../lib/export'
import { formatNs } from '../lib/format'
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

function RootSummary({ row, diff }: { row: PerformancePathDiff; diff: PerformanceDiff }) {
  return (
    <section className="panel pd-summary">
      <div className="pd-summary-main">
        <span className="micro-label">root operation</span>
        <strong>{row.path.join(' / ')}</strong>
        <Evidence row={row} />
      </div>
      <div className="pd-summary-metric">
        <span className="faint">baseline</span>
        <strong className="mono-num">{formatNs(row.baseline.meanNs)}</strong>
      </div>
      <div className="pd-summary-arrow">→</div>
      <div className="pd-summary-metric">
        <span className="faint">candidate</span>
        <strong className="mono-num">{formatNs(row.candidate.meanNs)}</strong>
      </div>
      <div className="pd-summary-change">
        <strong className={`mono-num pd-direction ${row.absoluteChangeNs > 0 ? 'slower' : 'faster'}`}>
          {row.absoluteChangeNs > 0 ? '+' : '−'}{formatNs(Math.abs(row.absoluteChangeNs))} · {percent(row.relativeChange)}
        </strong>
        <span className="faint mono-num">95% {interval(row)} · p adj {pValue(row.adjustedP)}</span>
      </div>
      <div className="pd-summary-samples faint mono-num">
        {diff.baselineOperations} → {diff.candidateOperations} operations · {diff.baselineInstances.length} nodes
      </div>
    </section>
  )
}

function ImpactTree({ rows, onSelect }: { rows: PerformancePathDiff[]; onSelect: (key: string) => void }) {
  const ordered = [...rows].sort((a, b) => {
    const left = a.path.join(PATH_SORT_SEPARATOR)
    const right = b.path.join(PATH_SORT_SEPARATOR)
    return left.localeCompare(right)
  })
  const max = Math.max(1, ...rows.map((row) => Math.max(row.baseline.meanNs, row.candidate.meanNs)))
  return (
    <section className="panel pd-tree-panel">
      <div className="panel-header">
        <span className="panel-title">differential call tree</span>
        <span className="faint">width = cost · color = evidence</span>
      </div>
      <div className="pd-tree">
        {ordered.map((row) => (
          <button
            type="button"
            key={row.key}
            className={`pd-tree-row pd-${row.evidence}`}
            style={{ marginLeft: `${row.depth * 18}px`, width: `calc(${Math.max(8, Math.max(row.baseline.meanNs, row.candidate.meanNs) / max * 100)}% - ${row.depth * 18}px)` }}
            onClick={() => onSelect(row.key)}
            title={`${row.path.join(' / ')} · ${formatNs(row.baseline.meanNs)} → ${formatNs(row.candidate.meanNs)} · ${percent(row.relativeChange)}`}
          >
            <span>{row.path.at(-1)}</span>
            <span className="mono-num">{percent(row.relativeChange)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

const PATH_SORT_SEPARATOR = '\u0000'

function RankedChanges({ rows, onSelect }: { rows: PerformancePathDiff[]; onSelect: (key: string) => void }) {
  const ranked = (evidence: 'regressed' | 'improved') => rows
    .filter((row) => row.evidence === evidence)
    .sort((a, b) => Math.abs(b.absoluteChangeNs) - Math.abs(a.absoluteChangeNs))
    .slice(0, 5)
  const group = (title: string, evidence: 'regressed' | 'improved') => (
    <div className="pd-ranked-group">
      <span className="micro-label">{title}</span>
      {ranked(evidence).length === 0 ? <span className="faint">none</span> : ranked(evidence).map((row) => (
        <button type="button" key={row.key} onClick={() => onSelect(row.key)}>
          <span title={row.path.join(' / ')}>{row.path.at(-1)}</span>
          <span className="mono-num">{row.absoluteChangeNs > 0 ? '+' : '−'}{formatNs(Math.abs(row.absoluteChangeNs))}</span>
        </button>
      ))}
    </div>
  )
  return <section className="panel pd-ranked">{group('largest regressions', 'regressed')}{group('largest improvements', 'improved')}</section>
}

function PathsTable({ rows, onSelect }: { rows: PerformancePathDiff[]; onSelect: (key: string) => void }) {
  return (
    <section className="panel pd-table-panel">
      <div className="pd-table-scroll">
        <table className="data pd-table">
          <thead><tr><th>path</th><th>evidence</th><th className="num">baseline</th><th className="num">candidate</th><th className="num">change</th><th className="num">95% CI</th><th className="num">p adj</th></tr></thead>
          <tbody>{rows.slice(0, 2000).map((row) => (
            <tr key={row.key} onClick={() => onSelect(row.key)}>
              <td className="pd-path" style={{ paddingLeft: `${12 + row.depth * 12}px` }}>{row.path.join(' / ')}</td>
              <td><Evidence row={row} /></td>
              <td className="num mono-num">{formatNs(row.baseline.meanNs)}</td>
              <td className="num mono-num">{formatNs(row.candidate.meanNs)}</td>
              <td className={`num mono-num pd-direction ${row.absoluteChangeNs > 0 ? 'slower' : 'faster'}`}>{percent(row.relativeChange)}</td>
              <td className="num mono-num">{interval(row)}</td>
              <td className="num mono-num">{pValue(row.adjustedP)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {rows.length > 2000 && <div className="pd-cap faint">showing 2,000 of {rows.length} paths</div>}
    </section>
  )
}

function NodeHeatmap({ rows, instances, onSelect }: { rows: PerformancePathDiff[]; instances: string[]; onSelect: (key: string) => void }) {
  return (
    <section className="panel pd-node-panel">
      <div className="pd-node-grid" style={{ gridTemplateColumns: `minmax(180px, 1fr) repeat(${instances.length}, minmax(80px, 0.5fr))` }}>
        <div className="pd-node-corner">path</div>
        {instances.map((id) => <div className="pd-node-head" key={id}>{id}</div>)}
        {rows.slice(0, 2000).map((row) => (
          <div className="pd-node-row" key={row.key} style={{ display: 'contents' }}>
            <button type="button" className="pd-node-path" onClick={() => onSelect(row.key)}>{row.path.join(' / ')}</button>
            {instances.map((id) => {
              const cell = row.instances.find((instance) => instance.instanceId === id)
              const change = cell?.relativeChange ?? null
              const strength = change === null ? 0 : Math.min(72, 16 + Math.abs(change) * 120)
              return <button
                type="button"
                className={`pd-node-cell ${change === null ? 'missing' : change > 0 ? 'slower' : 'faster'}`}
                style={change === null ? undefined : { background: `color-mix(in srgb, var(${change > 0 ? '--perf-regressed' : '--perf-improved'}) ${strength}%, transparent)` }}
                key={id}
                onClick={() => onSelect(row.key)}
                title={`${id} · ${percent(change)}`}
              >{percent(change)}</button>
            })}
          </div>
        ))}
      </div>
    </section>
  )
}

function Ecdf({ baseline, candidate }: { baseline: number[]; candidate: number[] }) {
  const all = [...baseline, ...candidate]
  const max = Math.max(1, ...all)
  const line = (values: number[]) => [...values].sort((a, b) => a - b).map((value, index) => {
    const x = 8 + value / max * 284
    const y = 112 - ((index + 1) / values.length) * 100
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg className="pd-ecdf" viewBox="0 0 300 120" role="img" aria-label="baseline and candidate empirical cumulative distributions">
      <line x1="8" y1="112" x2="292" y2="112" />
      <line x1="8" y1="12" x2="8" y2="112" />
      <path className="baseline" d={line(baseline)} />
      <path className="candidate" d={line(candidate)} />
    </svg>
  )
}

function PathDetails({ row, onClose }: { row: PerformancePathDiff; onClose: () => void }) {
  return (
    <aside className="panel pd-details">
      <div className="panel-header">
        <span className="panel-title">path detail</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>×</button>
      </div>
      <div className="pd-details-body">
        <div className="pd-breadcrumb">{row.path.join(' / ')}</div>
        <Evidence row={row} />
        <Ecdf baseline={row.baselineValuesNs} candidate={row.candidateValuesNs} />
        <div className="pd-legend"><span className="baseline">baseline</span><span className="candidate">candidate</span></div>
        <dl className="pd-detail-stats">
          <dt>mean</dt><dd>{formatNs(row.baseline.meanNs)} → {formatNs(row.candidate.meanNs)}</dd>
          <dt>median</dt><dd>{formatNs(row.baseline.medianNs)} → {formatNs(row.candidate.medianNs)}</dd>
          <dt>p95</dt><dd>{formatNs(row.baseline.p95Ns)} → {formatNs(row.candidate.p95Ns)}</dd>
          <dt>95% CI</dt><dd>{interval(row)}</dd>
          <dt>p / adjusted</dt><dd>{pValue(row.rawP)} / {pValue(row.adjustedP)}</dd>
          <dt>calls</dt><dd>{row.baselineCalls} → {row.candidateCalls}</dd>
          <dt>coverage</dt><dd>{percent(row.baselineCoverage, false)} → {percent(row.candidateCoverage, false)}</dd>
          <dt>errors</dt><dd>{row.baselineErrors} → {row.candidateErrors}</dd>
          <dt>outliers</dt><dd>{row.baseline.outliers} → {row.candidate.outliers}</dd>
        </dl>
        <table className="data pd-instance-table">
          <thead><tr><th>node</th><th className="num">baseline</th><th className="num">candidate</th><th className="num">change</th></tr></thead>
          <tbody>{row.instances.map((instance) => <tr key={instance.instanceId}>
            <td>{instance.instanceId}</td>
            <td className="num mono-num">{instance.baselineMeanNs === null ? '—' : formatNs(instance.baselineMeanNs)}</td>
            <td className="num mono-num">{instance.candidateMeanNs === null ? '—' : formatNs(instance.candidateMeanNs)}</td>
            <td className="num mono-num">{percent(instance.relativeChange)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </aside>
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
      {baselineModel === null || candidateModel === null ? (
        <div className="empty-state pd-empty">
          Choose a baseline and candidate. Either side can be a searched comparison or an export.
        </div>
      ) : analysis.loading ? (
        <div className="empty-state pd-empty"><span className="spinner" /> analyzing 10,000 resamples…</div>
      ) : analysis.error !== null ? (
        <div className="empty-state pd-empty pd-analysis-error">analysis failed: {analysis.error}</div>
      ) : analysis.result !== null ? (
        <div className={`pd-workspace ${selected === null ? '' : 'with-details'}`}>
          <div className="pd-content">
            <div className="pd-controls">
              <span className="pd-view-tabs">
                {(['overview', 'paths', 'nodes'] as const).map((item) => (
                  <button type="button" key={item} className={`chip ${view === item ? 'active' : ''}`} onClick={() => route({ view: item })}>{item}</button>
                ))}
              </span>
              <span className="pd-threshold">
                <span className="faint">noise threshold</span>
                {[0.01, 0.02, 0.05, 0.1].map((value) => (
                  <button type="button" key={value} className={`chip ${threshold === value ? 'active' : ''}`} onClick={() => route({ threshold: value })}>{value * 100}%</button>
                ))}
              </span>
            </div>
            {analysis.result.warning !== null && <div className="pd-warning">{analysis.result.warning}</div>}
            {view === 'overview' && (
              <>
                {analysis.result.root !== null && <RootSummary row={analysis.result.root} diff={analysis.result} />}
                <div className="pd-overview-grid">
                  <ImpactTree rows={analysis.result.paths} onSelect={(key) => route({ selectedPath: key })} />
                  <RankedChanges rows={analysis.result.paths} onSelect={(key) => route({ selectedPath: key })} />
                </div>
              </>
            )}
            {view === 'paths' && <PathsTable rows={analysis.result.paths} onSelect={(key) => route({ selectedPath: key })} />}
            {view === 'nodes' && (
              <NodeHeatmap
                rows={analysis.result.paths}
                instances={[...new Set([...analysis.result.baselineInstances, ...analysis.result.candidateInstances])]}
                onSelect={(key) => route({ selectedPath: key })}
              />
            )}
          </div>
          {selected !== null && <PathDetails row={selected} onClose={() => route({ selectedPath: null })} />}
        </div>
      ) : (
        <div className="empty-state pd-empty">no performance data</div>
      )}
    </div>
  )
}
