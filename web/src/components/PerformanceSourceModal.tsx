import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { buildCompareQuery, compareQueryLabel } from '../api/client'
import { importTraceExport } from '../lib/export'
import { formatAgo, formatNs, shortId } from '../lib/format'
import {
  DEFAULT_FILTER,
  type FilterState,
  type PerformanceSource,
  type PerformanceSourceModalProps,
  type RangeSelection,
  type TimeRange,
  type TraceSummary,
} from '../lib/model'
import { DEFAULT_RANGE, resolveRange } from '../lib/range'
import { groupTraceSummaries } from '../lib/searchResults'
import SearchPanel from './SearchPanel'
import './PerformanceSourceModal.css'

async function readExport(file: File): Promise<PerformanceSource> {
  let value: unknown
  try {
    value = JSON.parse(await file.text())
  } catch {
    throw new Error(`${file.name} is not valid JSON`)
  }
  return { kind: 'export', label: file.name, model: importTraceExport(value) }
}

function ResultRow({
  trace,
  compareQuery,
  loading,
  onSelect,
}: {
  trace: TraceSummary
  compareQuery: string | undefined
  loading: boolean
  onSelect: () => void
}) {
  const comparison = compareQuery !== undefined
  const name = trace.rootTraceName.replace(/ ×\d+$/, '') || trace.matchedSpanNames[0] || 'unnamed span'
  return <button type="button" className="psm-result" disabled={loading} onClick={onSelect}>
    <span className={`chip psm-result-kind ${comparison ? 'comparison' : ''}`}>{comparison ? 'comparison' : 'trace'}</span>
    <span className="psm-result-main">
      <strong title={name}>{name}</strong>
      <span className="faint">{comparison ? `${trace.services.length} providers · ${trace.matchedSpanIds.length} matched spans` : shortId(trace.traceId)}</span>
    </span>
    <span className="psm-result-time mono-num">{formatAgo(trace.startUnixMs)}</span>
    <span className="psm-result-duration mono-num">{formatNs(trace.durationMs * 1e6)}</span>
    <span className="psm-result-action">{loading ? <span className="spinner" /> : comparison ? 'use comparison' : 'use trace'}</span>
  </button>
}

export default function PerformanceSourceModal({ side, client, initialSpanName, onSelect, onClose }: PerformanceSourceModalProps) {
  const initialFilter = useMemo<FilterState>(() => ({
    ...DEFAULT_FILTER,
    name: initialSpanName,
    nameIsRegex: false,
  }), [initialSpanName])
  const [tab, setTab] = useState<'search' | 'upload'>('search')
  const [filter, setFilter] = useState<FilterState>(initialFilter)
  const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE)
  const filterRef = useRef(filter)
  const rangeRef = useRef(range)
  const modalRef = useRef<HTMLElement>(null)
  const [submitted, setSubmitted] = useState<{ filter: FilterState; range: TimeRange; nonce: number }>(() => ({
    filter: initialFilter,
    range: resolveRange(DEFAULT_RANGE, Date.now()),
    nonce: 1,
  }))
  const [loadingTraceId, setLoadingTraceId] = useState<string | null>(null)
  const [selectionError, setSelectionError] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    modalRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const search = useQuery({
    queryKey: ['performance-source-search', side, submitted.nonce],
    queryFn: () => client.searchTraces(submitted.filter, submitted.range),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  })
  const grouped = useMemo(
    () => search.data === undefined ? null : groupTraceSummaries(search.data, submitted.filter),
    [search.data, submitted.filter],
  )
  const compareQueries = useMemo(() => {
    const queries = new Map<string, string>()
    for (const group of grouped?.compares ?? []) {
      queries.set(group.row.traceId, buildCompareQuery(group.filter, submitted.range, 'spans'))
    }
    return queries
  }, [grouped, submitted.range])

  const changeFilter = (next: FilterState) => {
    filterRef.current = next
    setFilter(next)
  }
  const changeRange = (next: RangeSelection) => {
    rangeRef.current = next
    setRange(next)
  }
  const runSearch = () => setSubmitted((current) => ({
    filter: filterRef.current,
    range: resolveRange(rangeRef.current, Date.now()),
    nonce: current.nonce + 1,
  }))

  const selectResult = async (trace: TraceSummary) => {
    const query = compareQueries.get(trace.traceId)
    if (query !== undefined) {
      onSelect({ kind: 'query', query, label: compareQueryLabel(query) })
      return
    }

    setLoadingTraceId(trace.traceId)
    setSelectionError(null)
    try {
      const model = await client.fetchTrace(trace.traceId)
      onSelect({
        kind: 'trace',
        label: `${trace.rootTraceName || trace.matchedSpanNames[0] || 'trace'} · ${shortId(trace.traceId)}`,
        model,
      })
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : String(error))
      setLoadingTraceId(null)
    }
  }

  const chooseFile = async (file: File | undefined) => {
    if (file === undefined) return
    setSelectionError(null)
    try {
      onSelect(await readExport(file))
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : String(error))
    }
  }

  return createPortal(
    <div className="psm-backdrop" onMouseDown={onClose}>
      <section ref={modalRef} className="panel psm" role="dialog" aria-modal="true" aria-label={`choose ${side}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="psm-header">
          <div>
            <span className="micro-label">{side}</span>
            <h2>Choose a performance source</h2>
          </div>
          <span className="psm-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'search'} className={`chip ${tab === 'search' ? 'active' : ''}`} onClick={() => setTab('search')}>search spans</button>
            <button type="button" role="tab" aria-selected={tab === 'upload'} className={`chip ${tab === 'upload' ? 'active' : ''}`} onClick={() => setTab('upload')}>upload export</button>
          </span>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="close source picker" onClick={onClose}>×</button>
        </header>

        {tab === 'search' ? <div className="psm-search">
          <SearchPanel
            filter={filter}
            onChange={changeFilter}
            target="spans"
            range={range}
            onRangeChange={changeRange}
            onSearch={runSearch}
            searching={search.isFetching}
            client={client}
          />
          <section className="psm-results">
            <div className="psm-results-header">
              <div>
                <span className="panel-title">span results</span>
                <span className="faint"> {grouped?.rows.length ?? 0}</span>
              </div>
              <span className="faint">Add a span attribute to group matching operations across providers.</span>
            </div>
            {search.isLoading ? <div className="empty-state"><span className="spinner" /> searching…</div>
              : search.error !== null ? <div className="empty-state psm-error">{String(search.error)}</div>
              : grouped === null ? <div className="empty-state">run a search</div>
              : grouped.rows.length === 0 ? <div className="empty-state">no spans matched — widen the time range or relax filters</div>
              : <div className="psm-result-list">{grouped.rows.map((trace) => <ResultRow
                key={trace.traceId}
                trace={trace}
                compareQuery={compareQueries.get(trace.traceId)}
                loading={loadingTraceId === trace.traceId}
                onSelect={() => void selectResult(trace)}
              />)}</div>}
          </section>
        </div> : <div className="psm-upload-pane">
          <div className="psm-upload-copy">
            <span className="micro-label">trace export</span>
            <strong>Use a local tracer export</strong>
            <span className="faint">The file stays in this browser and is not uploaded to the server.</span>
          </div>
          <label className="btn btn-primary psm-upload-button">
            choose JSON file
            <input type="file" accept="application/json,.json" onChange={(event) => void chooseFile(event.target.files?.[0])} />
          </label>
        </div>}
        {selectionError !== null && <div className="psm-error-bar">{selectionError}</div>}
      </section>
    </div>,
    document.body,
  )
}
