import { useMemo, useState } from 'react'
import type { CompareHotPathsProps, SpanNode } from '../lib/model'
import { formatNs } from '../lib/format'
import { quantileValue } from './DistributionPlots'
import './CompareHotPaths.css'

interface PathRow {
  key: string
  path: string[]
  durations: number[]
  totalNs: number
  nodes: Set<string>
  errors: number
  spanId: string
}

function pathRows(model: CompareHotPathsProps['model']): PathRow[] {
  const rows = new Map<string, PathRow>()
  const visit = (span: SpanNode, parent: string[]) => {
    const path = [...parent, span.name]
    const key = path.join('\u001f')
    let row = rows.get(key)
    if (row === undefined) {
      row = { key, path, durations: [], totalNs: 0, nodes: new Set(), errors: 0, spanId: span.spanId }
      rows.set(key, row)
    }
    row.durations.push(span.durationNs)
    row.totalNs += span.durationNs
    row.nodes.add(span.instanceId)
    if (span.status === 'error' || span.level === 'error') row.errors++
    for (const child of span.children) visit(child, path)
  }
  for (const instance of model.instances) {
    for (const root of instance.rootSpans) visit(root, [])
  }
  return [...rows.values()]
}

type Sort = 'cost' | 'p95' | 'calls' | 'name'

export default function CompareHotPaths({ model, onSelectSpan }: CompareHotPathsProps) {
  const rows = useMemo(() => pathRows(model), [model])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('cost')
  const filtered = useMemo(() => {
    const match = query.trim().toLowerCase()
    const next = rows.filter((row) => match === '' || row.path.some((part) => part.toLowerCase().includes(match)))
    next.sort((a, b) => {
      if (sort === 'name') return a.path.join('/').localeCompare(b.path.join('/'))
      if (sort === 'p95') return quantileValue(b.durations, 0.95) - quantileValue(a.durations, 0.95)
      if (sort === 'calls') return b.durations.length - a.durations.length
      return b.totalNs - a.totalNs
    })
    return next
  }, [query, rows, sort])
  const maxCost = Math.max(1, ...rows.map((row) => row.totalNs))

  return <section className="panel chp">
    <header className="chp-toolbar">
      <div><span className="panel-title">hot paths</span><span className="faint"> {filtered.length} call paths · inclusive span time</span></div>
      <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="filter call paths" aria-label="filter hot paths" />
      <span className="chp-sort">
        {(['cost', 'p95', 'calls', 'name'] as const).map((value) => <button type="button" className={`chip ${sort === value ? 'active' : ''}`} key={value} onClick={() => setSort(value)}>{value}</button>)}
      </span>
    </header>
    <div className="chp-list">
      {filtered.slice(0, 2000).map((row) => {
        const p50 = quantileValue(row.durations, 0.5)
        const p95 = quantileValue(row.durations, 0.95)
        return <button type="button" className="chp-card" key={row.key} onClick={() => onSelectSpan(row.spanId)}>
          <span className="chp-card-head"><strong>{row.path.at(-1)}</strong><span className="mono-num">{formatNs(row.totalNs)} total</span></span>
          <span className="chp-card-path faint" title={row.path.join(' / ')}>{row.path.slice(0, -1).join(' / ') || 'root'}</span>
          <span className="chp-cost"><i style={{ width: `${row.totalNs / maxCost * 100}%` }} /></span>
          <span className="chp-card-stats">
            <span><i>p50</i><strong className="mono-num">{formatNs(p50)}</strong></span>
            <span><i>p95</i><strong className="mono-num">{formatNs(p95)}</strong></span>
            <span><i>calls</i><strong className="mono-num">{row.durations.length}</strong></span>
            <span><i>nodes</i><strong className="mono-num">{row.nodes.size}</strong></span>
            <span><i>errors</i><strong className={row.errors > 0 ? 'level-error mono-num' : 'faint mono-num'}>{row.errors}</strong></span>
          </span>
        </button>
      })}
    </div>
    {filtered.length > 2000 && <div className="chp-cap faint">showing 2,000 of {filtered.length} paths</div>}
  </section>
}
