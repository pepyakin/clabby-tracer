import { useMemo } from 'react'
import type { LatencyAnalysis, LatencyPathDiffProps, LatencyPathSummary } from '../lib/model'
import { formatNs } from '../lib/format'
import { analyzeLatencyPaths } from '../lib/latencyPath'
import LatencyPathTimeline from './LatencyPathTimeline'
import './LatencyPathDiff.css'

interface ContributorDiff {
  key: string
  path: string[]
  baseline: LatencyPathSummary | null
  candidate: LatencyPathSummary | null
  changeNs: number
}

function signedDuration(value: number): string {
  if (value === 0) return formatNs(0)
  return `${value > 0 ? '+' : '−'}${formatNs(Math.abs(value))}`
}

function relativeChange(baseline: number, candidate: number): string {
  if (baseline === 0) return candidate === 0 ? '0%' : 'added'
  const value = (candidate - baseline) / baseline
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(Math.abs(value) < 0.1 ? 1 : 0)}%`
}

function contributorDiffs(baseline: LatencyAnalysis, candidate: LatencyAnalysis): ContributorDiff[] {
  const baselineByKey = new Map(baseline.paths.map((path) => [path.key, path]))
  const candidateByKey = new Map(candidate.paths.map((path) => [path.key, path]))
  const keys = new Set([...baselineByKey.keys(), ...candidateByKey.keys()])
  return [...keys].map((key) => {
    const before = baselineByKey.get(key) ?? null
    const after = candidateByKey.get(key) ?? null
    return {
      key,
      path: before?.path ?? after?.path ?? [],
      baseline: before,
      candidate: after,
      changeNs: (after?.meanNs ?? 0) - (before?.meanNs ?? 0),
    }
  }).sort((a, b) => Math.abs(b.changeNs) - Math.abs(a.changeNs))
}

function SummaryMetric({ label, baseline, candidate }: { label: string; baseline: number; candidate: number }) {
  const change = candidate - baseline
  return <div className="lpd-metric">
    <span className="micro-label">{label}</span>
    <span><strong className="mono-num">{formatNs(baseline)}</strong><i>→</i><strong className="mono-num">{formatNs(candidate)}</strong></span>
    <em className={change > 0 ? 'slower' : change < 0 ? 'faster' : ''}>{signedDuration(change)} · {relativeChange(baseline, candidate)}</em>
  </div>
}

export default function LatencyPathDiff({ baseline, candidate, onSelectPath }: LatencyPathDiffProps) {
  const baselineAnalysis = useMemo(() => analyzeLatencyPaths(baseline), [baseline])
  const candidateAnalysis = useMemo(() => analyzeLatencyPaths(candidate), [candidate])
  const contributors = useMemo(
    () => contributorDiffs(baselineAnalysis, candidateAnalysis),
    [baselineAnalysis, candidateAnalysis],
  )
  const maxContribution = Math.max(1, ...contributors.flatMap((row) => [row.baseline?.meanNs ?? 0, row.candidate?.meanNs ?? 0]))

  if (baselineAnalysis.representative === null || candidateAnalysis.representative === null) {
    return <section className="panel lpd"><div className="empty-state">both traces need at least one operation</div></section>
  }

  return <section className="panel lpd">
    <header className="lpd-header">
      <div><span className="panel-title">latency path comparison</span><span className="faint"> wall time counted once per operation</span></div>
      <span className="faint">Contribution changes are descriptive; dashed intervals contain parallel work with ambiguous ownership.</span>
    </header>
    <div className="lpd-body">
      <div className="lpd-metrics">
        <SummaryMetric label="mean envelope" baseline={baselineAnalysis.meanDurationNs} candidate={candidateAnalysis.meanDurationNs} />
        <SummaryMetric label="p95 envelope" baseline={baselineAnalysis.p95DurationNs} candidate={candidateAnalysis.p95DurationNs} />
        <SummaryMetric label="unattributed gap" baseline={baselineAnalysis.meanUnattributedNs} candidate={candidateAnalysis.meanUnattributedNs} />
        <SummaryMetric label="ambiguous overlap" baseline={baselineAnalysis.meanAmbiguousNs} candidate={candidateAnalysis.meanAmbiguousNs} />
      </div>
      <section className="lpd-timelines">
        <div><span className="panel-title">representative operations</span><span className="faint"> median-duration sample from each trace</span></div>
        <label><span>baseline</span><strong className="mono-num">{formatNs(baselineAnalysis.representative.durationNs)}</strong></label>
        <LatencyPathTimeline operation={baselineAnalysis.representative} />
        <label><span>candidate</span><strong className="mono-num">{formatNs(candidateAnalysis.representative.durationNs)}</strong></label>
        <LatencyPathTimeline operation={candidateAnalysis.representative} />
      </section>
      <section className="lpd-contributors">
        <div className="lpd-section-heading">
          <div><span className="panel-title">wall-time contribution shifts</span><span className="faint"> mean exclusive contribution across operations</span></div>
          <span className="faint">largest absolute changes first</span>
        </div>
        <div className="lpd-list">
          {contributors.map((row) => {
            const before = row.baseline?.meanNs ?? 0
            const after = row.candidate?.meanNs ?? 0
            return <button type="button" key={row.key} onClick={() => onSelectPath(row.key)}>
              <span className="lpd-path" title={row.path.join(' / ')}><strong>{row.path.at(-1)}</strong><span className="faint">{row.path.slice(0, -1).join(' / ') || 'root'}</span></span>
              <span className="lpd-bars">
                <i><b style={{ width: `${before / maxContribution * 100}%` }} /></i>
                <i><b style={{ width: `${after / maxContribution * 100}%` }} /></i>
              </span>
              <span className="lpd-values mono-num"><span>{formatNs(before)}</span><span>{formatNs(after)}</span></span>
              <strong className={`mono-num ${row.changeNs > 0 ? 'slower' : row.changeNs < 0 ? 'faster' : ''}`}>{signedDuration(row.changeNs)}</strong>
              <span className="faint mono-num">{relativeChange(before, after)}</span>
            </button>
          })}
        </div>
      </section>
    </div>
  </section>
}
