import type { LatencyPathTimelineProps } from '../lib/model'
import { formatNs } from '../lib/format'
import './LatencyPathTimeline.css'

const TONES = ['--level-info', '--level-debug', '--level-warn', '--level-trace', '--accent'] as const

function tone(path: string[]): string {
  let hash = 2166136261
  for (const character of path.join('\u001f')) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `var(${TONES[(hash >>> 0) % TONES.length]})`
}

export default function LatencyPathTimeline({ operation, onSelectSpan }: LatencyPathTimelineProps) {
  return <div className="lpt" role="img" aria-label="non-overlapping latency attribution timeline">
    {operation.segments.map((segment, index) => {
      const left = (segment.startNs - operation.startNs) / operation.durationNs * 100
      const width = segment.durationNs / operation.durationNs * 100
      const label = segment.path?.at(-1) ?? 'unattributed'
      const title = `${segment.path?.join(' / ') ?? 'unattributed gap'}\n${formatNs(segment.durationNs)} (${width.toFixed(1)}%)${segment.ambiguous ? '\nparallel ownership is ambiguous' : ''}`
      const style = {
        left: `${left}%`,
        width: `${width}%`,
        background: segment.path === null ? 'var(--surface-hover)' : tone(segment.path),
      }
      if (segment.spanId !== null && onSelectSpan !== undefined) {
        return <button
          type="button"
          key={`${segment.startNs}-${index}`}
          className={segment.ambiguous ? 'ambiguous' : ''}
          style={style}
          title={title}
          onClick={() => onSelectSpan(segment.spanId!)}
        ><span>{label}</span></button>
      }
      const classes = [
        'lpt-segment',
        segment.path === null ? 'unattributed' : '',
        segment.ambiguous ? 'ambiguous' : '',
      ].filter(Boolean).join(' ')
      return <span key={`${segment.startNs}-${index}`} className={classes} style={style} title={title}><span>{label}</span></span>
    })}
  </div>
}
