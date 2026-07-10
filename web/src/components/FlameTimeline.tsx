import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import './FlameTimeline.css'

interface FlameTimelineProps {
  low: number
  high: number
  viewLow: number
  viewHigh: number
  trackRef: RefObject<HTMLDivElement | null>
  label?: string
  labelWidth?: number
  children: ReactNode
  onChange: (low: number, high: number) => void
  onReset: () => void
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

export default function FlameTimeline({
  low,
  high,
  viewLow,
  viewHigh,
  trackRef,
  label,
  labelWidth,
  children,
  onChange,
  onReset,
}: FlameTimelineProps) {
  const span = Math.max(1, high - low)
  const windowLow = clamp(viewLow, low, high)
  const windowHigh = clamp(viewHigh, low, high)
  const left = (windowLow - low) / span * 100
  const width = Math.max((windowHigh - windowLow) / span * 100, 0.6)
  const zoomed = windowHigh - windowLow < span - 0.5

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const track = trackRef.current
    if (track === null) return
    event.preventDefault()
    const rect = track.getBoundingClientRect()
    const valueAt = (clientX: number) =>
      low + clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1) * span
    const data = (event.target as HTMLElement).dataset
    const mode = data.timelineHandle === 'left'
      ? 'left'
      : data.timelineHandle === 'right'
        ? 'right'
        : data.timelineWindow === 'true'
          ? 'pan'
          : 'select'
    const initialLow = windowLow
    const initialHigh = windowHigh
    const anchor = valueAt(event.clientX)
    const downX = event.clientX
    let moved = false

    const onMove = (moveEvent: PointerEvent) => {
      if (!moved && mode === 'select' && Math.abs(moveEvent.clientX - downX) < 3) return
      moved = true
      const current = valueAt(moveEvent.clientX)
      if (mode === 'pan') {
        const shift = current - anchor
        onChange(initialLow + shift, initialHigh + shift)
        return
      }
      if (mode === 'left') {
        onChange(Math.min(current, initialHigh), initialHigh)
        return
      }
      if (mode === 'right') {
        onChange(initialLow, Math.max(current, initialLow))
        return
      }
      onChange(Math.min(anchor, current), Math.max(anchor, current))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return <div className="ft">
    {label !== undefined && <span className="ft-label" style={{ width: labelWidth }}>{label}</span>}
    <div
      ref={trackRef}
      className="ft-track"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      title="drag to scrub · drag an edge to zoom · drag empty track to select a range · double-click to reset"
    >
      {children}
      <div
        className={`ft-window${zoomed ? ' zoomed' : ''}`}
        data-timeline-window="true"
        style={{ left: `${left}%`, width: `${width}%` }}
      >
        <span className="ft-handle left" data-timeline-handle="left" />
        <span className="ft-handle right" data-timeline-handle="right" />
      </div>
    </div>
  </div>
}
