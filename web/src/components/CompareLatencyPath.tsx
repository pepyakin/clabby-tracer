import { useMemo } from 'react'
import type { CompareLatencyPathProps, LatencyPathSummary } from '../lib/model'
import { formatNs, shortId } from '../lib/format'
import { analyzeLatencyPaths } from '../lib/latencyPath'
import LatencyPathTimeline from './LatencyPathTimeline'
import './CompareLatencyPath.css'

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="clp-metric">
    <span className="micro-label">{label}</span>
    <strong className="mono-num">{value}</strong>
    {note !== undefined && <span className="faint">{note}</span>}
  </div>
}

function contributionSpanId(path: LatencyPathSummary, operations: ReturnType<typeof analyzeLatencyPaths>['operations']): string | null {
  for (const operation of operations) {
    const segment = operation.segments.find((item) => item.path?.join('\u001f') === path.key)
    if (segment?.spanId !== null && segment?.spanId !== undefined) return segment.spanId
  }
  return null
}

export default function CompareLatencyPath({ model, onSelectSpan }: CompareLatencyPathProps) {
  const analysis = useMemo(() => analyzeLatencyPaths(model), [model])
  const maxContribution = Math.max(1, ...analysis.paths.map((path) => path.meanNs))
  const instanceNames = new Map(model.instances.map((instance) => [instance.id, instance.serviceName]))

  if (analysis.representative === null) return <section className="panel clp"><div className="empty-state">no operations to attribute</div></section>

  return <section className="panel clp">
    <header className="clp-header">
      <div><span className="panel-title">latency path</span><span className="faint"> wall time counted once · deepest active span owns each interval</span></div>
      <span className="faint">Dashed segments contain parallel work with ambiguous ownership.</span>
    </header>
    <div className="clp-body">
      <div className="clp-metrics">
        <Metric label="mean operation" value={formatNs(analysis.meanDurationNs)} note={`${analysis.operations.length} operations`} />
        <Metric label="p95 operation" value={formatNs(analysis.p95DurationNs)} />
        <Metric label="unattributed" value={formatNs(analysis.meanUnattributedNs)} note="mean gap per operation" />
        <Metric label="ambiguous overlap" value={formatNs(analysis.meanAmbiguousNs)} note="already counted, not added" />
      </div>
      <section className="clp-timeline-card">
        <div className="clp-section-heading">
          <div><span className="panel-title">representative operation</span><span className="faint"> median-duration sample · {instanceNames.get(analysis.representative.instanceId) ?? shortId(analysis.representative.instanceId)}</span></div>
          <strong className="mono-num">{formatNs(analysis.representative.durationNs)}</strong>
        </div>
        <LatencyPathTimeline operation={analysis.representative} onSelectSpan={onSelectSpan} />
      </section>
      <div className="clp-analysis-grid">
        <section className="clp-contributors">
          <div className="clp-section-heading"><span className="panel-title">wall-time contributors</span><span className="faint">mean contribution across operations</span></div>
          <div className="clp-contributor-list">
            {analysis.paths.map((path) => {
              const spanId = contributionSpanId(path, analysis.operations)
              return <button type="button" key={path.key} disabled={spanId === null} onClick={() => spanId !== null && onSelectSpan(spanId)}>
                <span className="clp-path"><strong>{path.path.at(-1)}</strong><span className="faint" title={path.path.join(' / ')}>{path.path.slice(0, -1).join(' / ') || 'root'}</span></span>
                <span className="clp-bar"><i style={{ width: `${path.meanNs / maxContribution * 100}%` }} /></span>
                <span className="mono-num">{formatNs(path.meanNs)}</span>
                <span className="faint mono-num">p95 {formatNs(path.p95Ns)}</span>
                <span className="faint mono-num">{Math.round(path.coverage * 100)}%</span>
              </button>
            })}
          </div>
        </section>
        <section className="clp-nodes">
          <div className="clp-section-heading"><span className="panel-title">slowest nodes</span><span className="faint">mean root envelope</span></div>
          <div>{analysis.instances.map((instance, index) => <span key={instance.instanceId}>
            <i>{index + 1}</i>
            <strong title={instanceNames.get(instance.instanceId) ?? instance.instanceId}>{instanceNames.get(instance.instanceId) ?? shortId(instance.instanceId)}</strong>
            <span className="faint">{instance.operations} ops</span>
            <span className="mono-num">{formatNs(instance.meanNs)}</span>
          </span>)}</div>
        </section>
      </div>
    </div>
  </section>
}
