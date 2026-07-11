import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { CumulativeDistributionPlotProps, NodeDistributionPlotProps } from '../lib/model'
import { instanceColorVar } from '../lib/model'
import { formatNs } from '../lib/format'
import './DistributionPlots.css'

function usePlotWidth(initialWidth: number): [RefObject<SVGSVGElement | null>, number] {
  const ref = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(initialWidth)

  useLayoutEffect(() => {
    const svg = ref.current
    if (svg === null) return

    const resize = () => setWidth(Math.max(120, Math.round(svg.clientWidth)))
    resize()

    const observer = new ResizeObserver(resize)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}

export function quantileValue(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * percentile
  const low = Math.floor(position)
  const high = Math.ceil(position)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

export function CumulativeDistributionPlot({ series, ariaLabel }: CumulativeDistributionPlotProps) {
  const [svgRef, width] = usePlotWidth(720)
  const values = series.flatMap((item) => item.values)
  const max = Math.max(1, ...values)
  const left = 48
  const right = width - 12
  const top = 12
  const bottom = 156
  const x = (value: number) => left + value / max * (right - left)
  const y = (fraction: number) => bottom - fraction * (bottom - top)
  const line = (samples: number[]) => {
    const ordered = [...samples].sort((a, b) => a - b)
    let path = `M${left},${bottom}`
    ordered.forEach((value, index) => {
      path += ` H${x(value).toFixed(1)} V${y((index + 1) / ordered.length).toFixed(1)}`
    })
    return path
  }

  return <svg ref={svgRef} className="dc-ecdf" viewBox={`0 0 ${width} 185`} role="img" aria-label={ariaLabel}>
    <line className="axis" x1={left} y1={bottom} x2={right} y2={bottom} />
    <line className="axis" x1={left} y1={top} x2={left} y2={bottom} />
    {[0, 0.5, 1].map((fraction) => <g key={`y-${fraction}`}>
      <line className="grid" x1={left} y1={y(fraction)} x2={right} y2={y(fraction)} />
      <text x={left - 8} y={y(fraction) + 3} textAnchor="end">{fraction * 100}%</text>
    </g>)}
    {[0, 0.5, 1].map((fraction) => <g key={`x-${fraction}`}>
      <line className="tick" x1={x(max * fraction)} y1={bottom} x2={x(max * fraction)} y2={bottom + 4} />
      <text x={x(max * fraction)} y={bottom + 17} textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}>{formatNs(max * fraction)}</text>
    </g>)}
    {series.map((item) => <path key={item.label} className={item.tone} d={line(item.values)}><title>{item.label}</title></path>)}
  </svg>
}

export function NodeDistributionPlot({ lanes, ariaLabel }: NodeDistributionPlotProps) {
  const [svgRef, width] = usePlotWidth(720)
  const values = lanes.flatMap((lane) => lane.points.map((point) => point.value))
  const max = Math.max(1, ...values)
  const left = 78
  const right = width - 12
  const top = 18
  const rowGap = 54
  const firstRow = 42
  const bottom = firstRow + Math.max(0, lanes.length - 1) * rowGap + 30
  const height = bottom + 22
  const x = (value: number) => left + value / max * (right - left)

  return <svg ref={svgRef} className="dc-nodes" viewBox={`0 0 ${width} ${height}`} style={{ height }} role="img" aria-label={ariaLabel}>
    {[0, 0.5, 1].map((fraction) => <g key={fraction}>
      <line className="grid" x1={x(max * fraction)} y1={top} x2={x(max * fraction)} y2={bottom - 14} />
      <text x={x(max * fraction)} y={bottom + 8} textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}>{formatNs(max * fraction)}</text>
    </g>)}
    {lanes.map((lane, laneIndex) => {
      const y = firstRow + laneIndex * rowGap
      const rowValues = lane.points.map((point) => point.value)
      const q10 = quantileValue(rowValues, 0.1)
      const q25 = quantileValue(rowValues, 0.25)
      const median = quantileValue(rowValues, 0.5)
      const q75 = quantileValue(rowValues, 0.75)
      const q90 = quantileValue(rowValues, 0.9)
      return <g key={lane.label} className={lane.tone}>
        <text className="lane-label" x={left - 12} y={y + 4} textAnchor="end">{lane.label}</text>
        <line className="whisker" x1={x(q10)} y1={y} x2={x(q90)} y2={y} />
        <rect className="band" x={x(q25)} y={y - 10} width={Math.max(1, x(q75) - x(q25))} height="20" rx="4" />
        <line className="median" x1={x(median)} y1={y - 13} x2={x(median)} y2={y + 13} />
        {lane.points.map((point) => <circle
          key={point.id}
          cx={x(point.value)}
          cy={y + point.colorIndex % 13 - 6}
          r="3.5"
          style={{ fill: instanceColorVar(point.colorIndex) }}
        ><title>{point.id}: {formatNs(point.value)}</title></circle>)}
      </g>
    })}
  </svg>
}
