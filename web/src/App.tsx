import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faFileExport, faMoon, faSun } from '@fortawesome/free-solid-svg-icons'
import { ApiClient, buildCompareQuery } from './api/client'
import EventDetails from './components/EventDetails'
import ExportModal from './components/ExportModal'
import EventsView from './components/EventsView'
import SpanStats from './components/SpanStats'
import HeatMap from './components/HeatMap'
import FlameGraph from './components/FlameGraph'
import PerformanceDiffPage from './components/PerformanceDiffPage'
import SearchPanel from './components/SearchPanel'
import SpanDetails from './components/SpanDetails'
import TraceList from './components/TraceList'
import { shortId } from './lib/format'
import {
  DEFAULT_FILTER,
  isFilterConfigured,
  type EventSummary,
  type FilterState,
  type PerformanceDiffView,
  type PerformanceSource,
  type RangeSelection,
  type SearchTarget,
  type SpanEvent,
  type TimeRange,
  type TraceSummary,
} from './lib/model'
import { DEFAULT_RANGE, DEFAULT_REFRESH_SECONDS, resolveRange } from './lib/range'
import { groupEventSummaries, groupTraceSummaries } from './lib/searchResults'
import './App.css'

// ----------------------------------------------------------------- routing --

type Route =
  | { view: 'search' }
  | { view: 'trace'; traceId: string }
  | { view: 'compare'; query: string }
  | {
      view: 'diff'
      baselineQuery: string | null
      candidateQuery: string | null
      threshold: number
      diffView: PerformanceDiffView
      selectedPath: string | null
    }

function parseHash(): Route {
  const hash = window.location.hash
  const dm = /^#\/compare\/diff(?:\?(.*))?$/.exec(hash)
  if (dm) {
    const params = new URLSearchParams(dm[1] ?? '')
    const threshold = Number(params.get('threshold') ?? '0.02')
    const rawView = params.get('view')
    const diffView: PerformanceDiffView = rawView === 'paths' || rawView === 'nodes' ? rawView : 'overview'
    return {
      view: 'diff',
      baselineQuery: params.get('baseline'),
      candidateQuery: params.get('candidate'),
      threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 0.02,
      diffView,
      selectedPath: params.get('path'),
    }
  }
  const tm = /^#\/trace\/([0-9a-fA-F]+)/.exec(hash)
  if (tm) return { view: 'trace', traceId: tm[1].toLowerCase() }
  const cm = /^#\/compare(?:\?(.*))?$/.exec(hash)
  if (cm) return { view: 'compare', query: cm[1] ?? '' }
  return { view: 'search' }
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(parseHash)
  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const navigate = useCallback((r: Route) => {
    if (r.view === 'trace') {
      window.location.hash = `/trace/${r.traceId}`
      return
    }
    if (r.view === 'compare') {
      window.location.hash = `/compare?${r.query}`
      return
    }
    if (r.view === 'diff') {
      const params = new URLSearchParams()
      if (r.baselineQuery !== null) params.set('baseline', r.baselineQuery)
      if (r.candidateQuery !== null) params.set('candidate', r.candidateQuery)
      if (r.threshold !== 0.02) params.set('threshold', String(r.threshold))
      if (r.diffView !== 'overview') params.set('view', r.diffView)
      if (r.selectedPath !== null) params.set('path', r.selectedPath)
      const query = params.toString()
      window.location.hash = `/compare/diff${query === '' ? '' : `?${query}`}`
      return
    }
    window.location.hash = '/search'
  }, [])
  return [route, navigate]
}

// ---------------------------------------------------------------- settings --

type Theme = 'dark' | 'light'

// Fixed API base. The tracer API server (which talks to the deploy-time
// TEMPO_URL) serves it in production; in dev the Vite server proxies it to
// `bun run dev:api`. There is no in-app endpoint setting.
const API_BASE = '/api/v1'
const BASELINE_STORAGE_KEY = 'tracer.performance-baseline.v1'

function storedBaseline(): PerformanceSource | null {
  try {
    const value = sessionStorage.getItem(BASELINE_STORAGE_KEY)
    if (value === null) return null
    const parsed = JSON.parse(value) as { query?: unknown; label?: unknown }
    if (typeof parsed.query !== 'string' || typeof parsed.label !== 'string') return null
    return { kind: 'query', query: parsed.query, label: parsed.label }
  } catch {
    return null
  }
}

function compareLabel(query: string): string {
  const params = new URLSearchParams(query)
  const name = params.get('name') || 'comparison'
  const attr = params.getAll('attr')[0]
  return attr === undefined ? name : `${name} · ${attr}`
}

export default function App() {
  const [route, navigate] = useRoute()
  const [capturedBaseline, setCapturedBaseline] = useState<PerformanceSource | null>(storedBaseline)
  const captureBaseline = useCallback((source: PerformanceSource | null) => {
    setCapturedBaseline(source)
    if (source?.kind === 'query') {
      sessionStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify({ query: source.query, label: source.label }))
    } else {
      sessionStorage.removeItem(BASELINE_STORAGE_KEY)
    }
  }, [])

  // The theme defaults to the OS preference and tracks it live. The toolbar
  // toggle is an in-memory override only — never persisted, and reset by the
  // next OS theme change.
  const [theme, setTheme] = useState<Theme>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
  )
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) =>
      setTheme(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // The API endpoint is fixed at the relative /api/v1 path; the deployment
  // (the API server's TEMPO_URL, or the dev Vite proxy) decides what backs it.
  const client = useMemo(() => new ApiClient(API_BASE), [])

  const connected = useQuery({
    queryKey: ['ping'],
    queryFn: () => client.ping(),
    // Quick cadence so the status dot recovers within seconds of Tempo
    // coming back (ping never throws, so no retry/backoff involved).
    refetchInterval: 5_000,
    retry: false,
  })

  // ------------------------------------------------------------- search --

  // What the search targets: spans (trace rows) or events (event rows).
  const [target, setTarget] = useState<SearchTarget>('spans')
  const targetRef = useRef(target)
  // Spans and events keep INDEPENDENT filters — a span name + span attributes
  // are meaningless as an event query, so switching tabs must not carry them
  // over. The active filter is `filters[target]`.
  const [filters, setFilters] = useState<Record<SearchTarget, FilterState>>({
    spans: DEFAULT_FILTER,
    events: DEFAULT_FILTER,
  })
  const filter = filters[target]
  // Mirror of `filters` updated synchronously in the change handler so that a
  // search fired in the same event as a filter edit (e.g. Enter committing a
  // provider chip then bubbling to the panel's search handler) snapshots the
  // just-edited filter rather than the render-time closure.
  const filtersRef = useRef(filters)
  const onFilterChange = useCallback((f: FilterState) => {
    const next = { ...filtersRef.current, [targetRef.current]: f }
    filtersRef.current = next
    setFilters(next)
  }, [])
  const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE)
  // Mirror of `range` so an Enter-fired search snapshots the just-picked range.
  const rangeRef = useRef(range)
  const onRangeChange = useCallback((r: RangeSelection) => {
    rangeRef.current = r
    setRange(r)
  }, [])

  // Snapshot of (filter, target, range) captured when a search fires; bumping
  // `nonce` is what actually triggers the query. `rangeSel` is retained so a
  // refresh re-anchors relative ranges to "now" while keeping absolute ones
  // fixed (and keeps Live live). Initialized so results stream immediately.
  const [submitted, setSubmitted] = useState<{
    filter: FilterState
    target: SearchTarget
    rangeSel: RangeSelection
    range: TimeRange
    nonce: number
  }>(() => ({
    filter: DEFAULT_FILTER,
    target: 'spans',
    rangeSel: DEFAULT_RANGE,
    range: resolveRange(DEFAULT_RANGE, Date.now()),
    nonce: 1,
  }))

  const onSearch = useCallback(() => {
    setSubmitted((prev) => ({
      filter: filtersRef.current[targetRef.current],
      target: targetRef.current,
      rangeSel: rangeRef.current,
      range: resolveRange(rangeRef.current, Date.now()),
      nonce: prev.nonce + 1,
    }))
  }, [])

  // Switching the results tab searches the OTHER target with its own filter
  // (each tab keeps independent search parameters).
  const onTargetChange = useCallback(
    (t: SearchTarget) => {
      targetRef.current = t
      setTarget(t)
      onSearch()
    },
    [onSearch],
  )

  // Re-run the LAST SUBMITTED filter (not the draft), re-resolving its range.
  const onRefresh = useCallback(() => {
    setSubmitted((prev) => ({
      ...prev,
      range: resolveRange(prev.rangeSel, Date.now()),
      nonce: prev.nonce + 1,
    }))
  }, [])

  const [refreshSec, setRefreshSec] = useState(DEFAULT_REFRESH_SECONDS)
  useEffect(() => {
    if (refreshSec === 0 || route.view !== 'search') return
    const id = setInterval(onRefresh, refreshSec * 1000)
    // submitted.nonce in the deps restarts the timer whenever any search or
    // manual refresh fires, so the next auto tick is a full period away.
    return () => clearInterval(id)
  }, [refreshSec, onRefresh, submitted.nonce, route.view])

  type SearchResult =
    | { kind: 'spans'; rows: TraceSummary[] }
    | { kind: 'events'; rows: EventSummary[] }
  const search = useQuery<SearchResult>({
    queryKey: ['search', submitted.nonce],
    queryFn: async (): Promise<SearchResult> =>
      submitted.target === 'spans'
        ? { kind: 'spans', rows: await client.searchTraces(submitted.filter, submitted.range) }
        : { kind: 'events', rows: await client.searchEvents(submitted.filter, submitted.range) },
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  })
  const queryTraces = search.data?.kind === 'spans' ? search.data.rows : null
  const queryEvents = search.data?.kind === 'events' ? search.data.rows : null
  const groupedTraces = useMemo(
    () => (queryTraces === null ? null : groupTraceSummaries(queryTraces, submitted.filter)),
    [queryTraces, submitted.filter],
  )
  const groupedEvents = useMemo(
    () => (queryEvents === null ? null : groupEventSummaries(queryEvents, submitted.filter)),
    [queryEvents, submitted.filter],
  )
  const compareQueries = useMemo(() => {
    const out: Record<string, string> = {}
    const groups = groupedTraces?.compares ?? groupedEvents?.compares ?? []
    for (const group of groups) {
      out[group.row.traceId] = buildCompareQuery(group.filter, submitted.range, group.target)
    }
    return out
  }, [groupedTraces, groupedEvents, submitted.range])

  // -------------------------------------------------------------- trace --

  const traceId = route.view === 'trace' ? route.traceId : null
  const trace = useQuery({
    queryKey: ['trace', traceId],
    queryFn: () => client.fetchTrace(traceId!),
    enabled: traceId !== null,
  })

  // The comparison view assembles its own synthetic trace from the hash query.
  const compareQuery = route.view === 'compare' ? route.query : null
  const compare = useQuery({
    queryKey: ['compare', compareQuery],
    queryFn: () => client.compareByQuery(compareQuery!),
    enabled: compareQuery !== null,
  })

  // Both views feed the same trace UI; `viewKey` identifies the current one.
  const active = route.view === 'compare' ? compare : trace
  const model = active.data ?? null
  const viewKey = route.view === 'compare' ? `compare:${route.query}` : traceId

  const [tab, setTab] = useState<'flame' | 'events' | 'stats' | 'heatmap'>('flame')
  // The details pane shows either a span or an event.
  const [selected, setSelected] = useState<
    { kind: 'span'; spanId: string } | { kind: 'event'; event: SpanEvent } | null
  >(null)
  // The flamegraph outlines the selected span — for events, the owning span.
  const selectedSpanId =
    selected === null
      ? null
      : selected.kind === 'span'
        ? selected.spanId
        : selected.event.spanId
  const selectSpan = useCallback((id: string | null) => {
    setSelected(id === null ? null : { kind: 'span', spanId: id })
  }, [])
  const selectEvent = useCallback((event: SpanEvent) => {
    setSelected({ kind: 'event', event })
  }, [])
  const [hiddenInstances, setHiddenInstances] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [exportOpen, setExportOpen] = useState(false)
  const onToggleInstance = useCallback((id: string) => {
    setHiddenInstances((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  // Any hidden → reveal all; none hidden → hide all.
  const onToggleAllInstances = useCallback(() => {
    setHiddenInstances((prev) =>
      prev.size > 0 ? new Set() : new Set(model?.instances.map((i) => i.id) ?? []),
    )
  }, [model])

  // Reset per-trace UI state when switching traces or comparisons.
  const lastViewRef = useRef<string | null>(null)
  useEffect(() => {
    if (viewKey !== lastViewRef.current) {
      lastViewRef.current = viewKey
      setSelected(null)
      setHiddenInstances(new Set())
      setExportOpen(false)
      setTab('flame')
    }
  }, [viewKey])

  // When a trace is opened from search results, carry the search context in:
  // hide instances the service filter excluded. Opening an EVENT result also
  // pre-focuses that event's details pane; plain trace opens pre-select
  // nothing — the details pane stays closed until the user clicks something.
  const focusRef = useRef<{
    traceId: string
    services: string[]
    span?: string
    focusRoot?: boolean
    event?: { spanId: string; name: string }
  } | null>(null)

  const openTrace = useCallback(
    (id: string, matchedSpanIds: string[]) => {
      // Empty query → focus the outermost (root) span. A real query → focus the
      // span it matched, but ONLY when unambiguous (exactly one match);
      // multiple matches focus nothing rather than pick arbitrarily.
      const configured = isFilterConfigured(submitted.filter)
      focusRef.current = {
        traceId: id,
        services: submitted.filter.services,
        span: configured && matchedSpanIds.length === 1 ? matchedSpanIds[0] : undefined,
        focusRoot: !configured,
      }
      navigate({ view: 'trace', traceId: id })
    },
    [navigate, submitted],
  )

  const openCompare = useCallback(
    (query: string) => navigate({ view: 'compare', query }),
    [navigate],
  )

  const openEvent = useCallback(
    (e: EventSummary) => {
      focusRef.current = {
        traceId: e.traceId,
        services: submitted.filter.services,
        event: { spanId: e.spanId, name: e.eventName },
      }
      navigate({ view: 'trace', traceId: e.traceId })
    },
    [navigate, submitted],
  )

  useEffect(() => {
    const focus = focusRef.current
    if (!model || focus === null || focus.traceId !== model.traceId) return
    focusRef.current = null
    if (focus.services.length > 0) {
      const hidden = model.instances
        .filter((i) => !focus.services.includes(i.serviceName))
        .map((i) => i.id)
      // Never hide everything — an empty flamegraph would look broken.
      if (hidden.length < model.instances.length) {
        setHiddenInstances(new Set(hidden))
      }
    }
    if (focus.event !== undefined) {
      const span = model.spans.get(focus.event.spanId)
      const name = focus.event.name
      const ev = span?.events.find((x) => x.name === name)
      if (ev !== undefined) selectEvent(ev)
      else if (span !== undefined) selectSpan(span.spanId)
    } else if (focus.span !== undefined) {
      // Unambiguous match: pre-open that span's details pane.
      const span = model.spans.get(focus.span)
      if (span !== undefined) selectSpan(span.spanId)
    } else if (focus.focusRoot) {
      // Empty query: focus the outermost span.
      const root = model.instances[0]?.rootSpans[0]
      if (root !== undefined) selectSpan(root.spanId)
    }
  }, [model, selectEvent, selectSpan])

  return (
    <div className="app">
      <header className="app-topbar">
        <button
          className="app-logo"
          onClick={() => navigate({ view: 'search' })}
          title="back to search"
        >
          tracer<span className="app-logo-dot">●</span>
        </button>

        {route.view === 'trace' && (
          <div className="app-tracebar">
            <span className="app-traceid mono-num" title={route.traceId}>
              {shortId(route.traceId)}
            </span>
          </div>
        )}

        {route.view === 'compare' && (
          <div className="app-tracebar">
            <span className="app-traceid" title="cross-instance comparison">
              compare
            </span>
          </div>
        )}

        {route.view === 'diff' && (
          <div className="app-tracebar">
            <span className="app-traceid" title="baseline versus candidate performance">
              performance diff
            </span>
          </div>
        )}

        <div className="app-topbar-spacer" />

        <div className="app-topbar-end">
          {capturedBaseline !== null && (
            <span className="app-baseline chip" title={capturedBaseline.label}>
              baseline: {capturedBaseline.label}
              <button type="button" onClick={() => captureBaseline(null)} aria-label="clear baseline">×</button>
            </span>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => navigate({
              view: 'diff',
              baselineQuery: capturedBaseline?.kind === 'query' ? capturedBaseline.query : null,
              candidateQuery: route.view === 'compare' ? route.query : null,
              threshold: 0.02,
              diffView: 'overview',
              selectedPath: null,
            })}
          >
            performance diff
          </button>
          <span
            className={`app-conn ${connected.data ? 'ok' : 'down'}`}
            title={connected.data ? 'connected to Tempo' : 'Tempo unreachable'}
          >
            ● {connected.data ? 'tempo' : 'offline'}
          </span>
          <button
            className="btn btn-ghost btn-sm app-icon-btn"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title="toggle theme"
            aria-label="toggle theme"
          >
            <FontAwesomeIcon icon={theme === 'dark' ? faMoon : faSun} />
          </button>
        </div>
      </header>

      {route.view === 'search' ? (
        <main className="app-main app-search view-fade" key="search">
          <SearchPanel
            filter={filter}
            onChange={onFilterChange}
            target={target}
            range={range}
            onRangeChange={onRangeChange}
            onSearch={onSearch}
            searching={search.isFetching}
            client={client}
          />
          <TraceList
            target={target}
            onTargetChange={onTargetChange}
            results={groupedTraces?.rows ?? null}
            events={groupedEvents?.rows ?? null}
            compareQueries={compareQueries}
            loading={
              search.isLoading ||
              (search.isFetching && search.data?.kind !== submitted.target)
            }
            error={search.error ? String(search.error) : null}
            onOpen={openTrace}
            onOpenCompare={openCompare}
            onOpenEvent={openEvent}
            refreshing={search.isFetching}
            refreshSec={refreshSec}
            onRefreshSecChange={setRefreshSec}
            onRefresh={onRefresh}
          />
        </main>
      ) : route.view === 'diff' ? (
        <main className="app-main app-diff view-fade" key="performance-diff">
          <PerformanceDiffPage
            baselineQuery={route.baselineQuery}
            candidateQuery={route.candidateQuery}
            capturedBaseline={capturedBaseline}
            threshold={route.threshold}
            view={route.diffView}
            selectedPath={route.selectedPath}
            loadQuery={(query) => client.compareByQuery(query)}
            onCaptureBaseline={captureBaseline}
            onRouteChange={(next) => navigate({
              view: 'diff',
              baselineQuery: next.baselineQuery,
              candidateQuery: next.candidateQuery,
              threshold: next.threshold,
              diffView: next.view,
              selectedPath: next.selectedPath,
            })}
          />
        </main>
      ) : (
        <main className="app-main app-trace view-fade" key={viewKey ?? 'view'}>
          {active.isLoading && (
            <div className="empty-state">
              <div className="spinner" />
              {route.view === 'compare' ? 'assembling comparison…' : 'loading trace…'}
            </div>
          )}
          {active.error != null && (
            <div className="empty-state app-error">
              {route.view === 'compare' ? 'failed to assemble comparison: ' : 'failed to load trace: '}
              {String(active.error)}
            </div>
          )}
          {model && model.instances.length === 0 && (
            <div className="empty-state">
              {model.warnings[0] ?? 'no spans matched this comparison'}
            </div>
          )}
          {model && model.instances.length > 0 && (
            <>
              <div className="app-trace-toolbar">
                <div className="app-tabs">
                  <button
                    className={`chip ${tab === 'flame' ? 'active' : ''}`}
                    onClick={() => setTab('flame')}
                  >
                    flame
                  </button>
                  <button
                    className={`chip ${tab === 'events' ? 'active' : ''}`}
                    onClick={() => setTab('events')}
                  >
                    events ({model.events.length})
                  </button>
                  <button
                    className={`chip ${tab === 'stats' ? 'active' : ''}`}
                    onClick={() => setTab('stats')}
                  >
                    stats
                  </button>
                  <button
                    className={`chip ${tab === 'heatmap' ? 'active' : ''}`}
                    onClick={() => setTab('heatmap')}
                  >
                    heatmap
                  </button>
                </div>
                {route.view === 'compare' && (
                  <span className="app-compare-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => captureBaseline({
                        kind: 'query',
                        query: route.query,
                        label: compareLabel(route.query),
                      })}
                    >
                      set baseline
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => navigate({
                        view: 'diff',
                        baselineQuery: capturedBaseline?.kind === 'query' ? capturedBaseline.query : null,
                        candidateQuery: route.query,
                        threshold: 0.02,
                        diffView: 'overview',
                        selectedPath: null,
                      })}
                    >
                      compare performance
                    </button>
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm app-export"
                  title="export the displayed spans and events as JSON"
                  onClick={() => setExportOpen(true)}
                >
                  <FontAwesomeIcon icon={faFileExport} /> export
                </button>
                {model.warnings.length > 0 && (
                  <span
                    className="app-warnings level-warn"
                    title={model.warnings.join('\n')}
                  >
                    ⚠ {model.warnings.length}
                  </span>
                )}
              </div>
              {exportOpen && (
                <ExportModal
                  model={model}
                  hiddenInstances={hiddenInstances}
                  onClose={() => setExportOpen(false)}
                />
              )}
              <div className={`app-trace-body ${selected ? 'with-details' : ''}`}>
                <div className="app-trace-canvas">
                  {tab === 'flame' && (
                    <FlameGraph
                      model={model}
                      mode="instances"
                      selectedSpanId={selectedSpanId}
                      onSelect={selectSpan}
                      onSelectEvent={selectEvent}
                      hiddenInstances={hiddenInstances}
                      onToggleInstance={onToggleInstance}
                      onToggleAll={onToggleAllInstances}
                    />
                  )}
                  {tab === 'events' && (
                    <EventsView
                      model={model}
                      selectedSpanId={selectedSpanId}
                      onSelectSpan={selectSpan}
                      onSelectEvent={selectEvent}
                    />
                  )}
                  {tab === 'stats' && <SpanStats model={model} />}
                  {tab === 'heatmap' && <HeatMap model={model} />}
                </div>
                {selected?.kind === 'span' && (
                  <SpanDetails
                    model={model}
                    spanId={selected.spanId}
                    onClose={() => selectSpan(null)}
                    onSelectSpan={selectSpan}
                    onSelectEvent={selectEvent}
                  />
                )}
                {selected?.kind === 'event' && (
                  <EventDetails
                    model={model}
                    event={selected.event}
                    onClose={() => selectSpan(null)}
                    onSelectSpan={selectSpan}
                  />
                )}
              </div>
            </>
          )}
        </main>
      )}
    </div>
  )
}
