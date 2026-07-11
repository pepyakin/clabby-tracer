import { useEffect, useMemo, useState } from 'react'
import type { CompareStatsProps } from '../lib/model'
import { formatNs } from '../lib/format'
import { CumulativeDistributionPlot, NodeDistributionPlot, quantileValue } from './DistributionPlots'
import './CompareStats.css'

interface SpanGroup {
  name: string
  durations: number[]
  errors: number
  perInstance: Map<string, number[]>
  totalNs: number
}

function groupsFor(model: CompareStatsProps['model']): SpanGroup[] {
  const groups = new Map<string, SpanGroup>()
  for (const span of model.spans.values()) {
    let group = groups.get(span.name)
    if (group === undefined) {
      group = { name: span.name, durations: [], errors: 0, perInstance: new Map(), totalNs: 0 }
      groups.set(span.name, group)
    }
    group.durations.push(span.durationNs)
    group.totalNs += span.durationNs
    if (span.status === 'error' || span.level === 'error') group.errors++
    const instanceDurations = group.perInstance.get(span.instanceId)
    if (instanceDurations === undefined) group.perInstance.set(span.instanceId, [span.durationNs])
    else instanceDurations.push(span.durationNs)
  }
  return [...groups.values()].sort((a, b) => b.totalNs - a.totalNs)
}

function Summary({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="cs-summary-card">
    <span className="micro-label">{label}</span>
    <strong className="mono-num">{value}</strong>
    {note !== undefined && <span className="faint">{note}</span>}
  </div>
}

export default function CompareStats({ model }: CompareStatsProps) {
  const groups = useMemo(() => groupsFor(model), [model])
  const initialName = model.instances[0]?.rootSpans[0]?.name ?? groups[0]?.name ?? ''
  const [selectedName, setSelectedName] = useState(initialName)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!groups.some((group) => group.name === selectedName)) setSelectedName(initialName)
  }, [groups, initialName, selectedName])

  const selected = groups.find((group) => group.name === selectedName) ?? groups[0]
  const filtered = groups.filter((group) => group.name.toLowerCase().includes(query.trim().toLowerCase()))
  const totalCost = Math.max(1, ...groups.map((group) => group.totalNs))
  const instanceById = new Map(model.instances.map((instance) => [instance.id, instance]))

  if (selected === undefined) return <section className="panel cs"><div className="empty-state">no span statistics</div></section>

  const nodePoints = [...selected.perInstance].map(([instanceId, durations]) => ({
    id: instanceById.get(instanceId)?.serviceName ?? instanceId,
    value: durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
    colorIndex: instanceById.get(instanceId)?.colorIndex ?? 0,
  }))
  const p50 = quantileValue(selected.durations, 0.5)
  const p95 = quantileValue(selected.durations, 0.95)
  const p99 = quantileValue(selected.durations, 0.99)

  return <section className="panel cs">
    <aside className="cs-index">
      <div className="cs-index-header">
        <div><span className="panel-title">span statistics</span><span className="faint"> {groups.length}</span></div>
        <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="filter spans" aria-label="filter span statistics" />
      </div>
      <div className="cs-span-list">
        {filtered.map((group) => <button type="button" className={group.name === selected.name ? 'active' : ''} key={group.name} onClick={() => setSelectedName(group.name)}>
          <span className="cs-span-row-head"><strong title={group.name}>{group.name}</strong><span className="mono-num">{formatNs(quantileValue(group.durations, 0.95))}</span></span>
          <span className="cs-span-row-meta faint"><span>{group.durations.length} calls · {group.perInstance.size} nodes</span><span>{formatNs(group.totalNs)} total</span></span>
          <i style={{ width: `${group.totalNs / totalCost * 100}%` }} />
        </button>)}
      </div>
    </aside>
    <div className="cs-detail">
      <header className="cs-detail-header">
        <div><span className="micro-label">selected span</span><h2>{selected.name}</h2></div>
        <span className="faint">Distribution across {selected.perInstance.size} nodes and {selected.durations.length} calls</span>
      </header>
      <div className="cs-summary">
        <Summary label="p50" value={formatNs(p50)} />
        <Summary label="p95" value={formatNs(p95)} />
        <Summary label="p99" value={formatNs(p99)} note={selected.durations.length < 200 ? 'sparse tail' : undefined} />
        <Summary label="maximum" value={formatNs(Math.max(...selected.durations))} />
        <Summary label="errors" value={selected.errors === 0 ? '0' : `${selected.errors}`} note={`${(selected.errors / selected.durations.length * 100).toFixed(1)}% of calls`} />
      </div>
      <section className="cs-plot-card">
        <div className="cs-section-heading"><span className="panel-title">node distribution</span><span className="faint">mean per node · band = middle 50% · whisker = 10–90%</span></div>
        <NodeDistributionPlot ariaLabel={`${selected.name} mean duration by node`} lanes={[{ label: 'node mean', points: nodePoints, tone: 'accent' }]} />
      </section>
      <section className="cs-plot-card">
        <div className="cs-section-heading"><span className="panel-title">operation distribution</span><span className="faint">empirical cumulative distribution</span></div>
        <CumulativeDistributionPlot ariaLabel={`${selected.name} empirical cumulative distribution`} series={[{ label: selected.name, values: selected.durations, tone: 'accent' }]} />
      </section>
    </div>
  </section>
}
