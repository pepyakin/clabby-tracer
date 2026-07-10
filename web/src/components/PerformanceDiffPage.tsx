import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  PerformanceDiffPageProps,
  PerformanceSource,
  TraceModel,
} from '../lib/model'
import { importTraceExport } from '../lib/export'
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
    if (baselineQuery !== null && baselineLive.data !== undefined) {
      return { kind: 'query', query: baselineQuery, label: queryLabel(baselineQuery) }
    }
    return baselineQuery === null ? capturedBaseline : null
  }, [baselineQuery, baselineLive.data, capturedBaseline])
  const candidate = useMemo<PerformanceSource | null>(() => {
    if (candidateQuery !== null && candidateLive.data !== undefined) {
      return { kind: 'query', query: candidateQuery, label: queryLabel(candidateQuery) }
    }
    return candidateQuery === null ? candidateUpload : null
  }, [candidateQuery, candidateLive.data, candidateUpload])
  const baselineModel: TraceModel | null = baselineQuery !== null
    ? baselineLive.data ?? null
    : baseline?.kind === 'export' ? baseline.model : null
  const candidateModel: TraceModel | null = candidateQuery !== null
    ? candidateLive.data ?? null
    : candidate?.kind === 'export' ? candidate.model : null

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
      ) : (
        <div className="panel pd-ready">
          <span className="panel-title">inputs ready</span>
          <span className="faint">performance analysis loading…</span>
        </div>
      )}
    </div>
  )
}
