/*
 * Structured trace export — a compact, agent-friendly JSON representation of
 * the spans and events currently displayed, namespaced by service instance.
 * Times are milliseconds relative to the trace start (µs precision); empty
 * and unset fields are omitted to keep the payload small.
 */

import type {
  Attributes,
  Instance,
  Level,
  SpanEvent,
  SpanNode,
  TraceModel,
} from './model'
import { colorIndexForService } from './model'

export interface ExportedEvent {
  name: string
  /** Offset from the trace start, milliseconds. */
  offsetMs: number
  level?: Level
  attributes?: Attributes
}

export interface ExportedSpan {
  name: string
  spanId: string
  /** Offset from the trace start, milliseconds. */
  startOffsetMs: number
  durationMs: number
  level?: Level
  status?: 'ok' | 'error'
  statusMessage?: string
  attributes?: Attributes
  events?: ExportedEvent[]
  children?: ExportedSpan[]
}

export interface ExportedTrace {
  /** Present on exports created after the performance-diff feature. */
  format?: 'tracer.trace'
  version?: 1
  source?: { kind: 'compare'; query: string }
  traceId: string
  /** ISO-8601 wall clock of the trace start. */
  startTime: string
  durationMs: number
  /** Instance id (service.name[#tag]) → its span trees. */
  services: Record<string, { spans: ExportedSpan[] }>
}

/** Nanoseconds → milliseconds with microsecond precision. */
function ms(ns: number): number {
  return Math.round(ns / 1e3) / 1e3
}

function exportEvent(ev: SpanEvent): ExportedEvent {
  const out: ExportedEvent = { name: ev.name, offsetMs: ms(ev.timeNs) }
  if (ev.level !== null) out.level = ev.level
  if (Object.keys(ev.attributes).length > 0) out.attributes = ev.attributes
  return out
}

function exportSpan(span: SpanNode): ExportedSpan {
  const out: ExportedSpan = {
    name: span.name,
    spanId: span.spanId,
    startOffsetMs: ms(span.startNs),
    durationMs: ms(span.durationNs),
  }
  if (span.level !== null) out.level = span.level
  if (span.status !== 'unset') out.status = span.status
  if (span.statusMessage !== '') out.statusMessage = span.statusMessage
  if (Object.keys(span.attributes).length > 0) out.attributes = span.attributes
  if (span.events.length > 0) out.events = span.events.map(exportEvent)
  if (span.children.length > 0) out.children = span.children.map(exportSpan)
  return out
}

/**
 * Export the displayed portion of a trace: instances in `hidden` are
 * excluded, exactly like the flamegraph.
 */
export function exportTrace(
  model: TraceModel,
  hidden: ReadonlySet<string>,
  source?: { kind: 'compare'; query: string },
): ExportedTrace {
  const services: Record<string, { spans: ExportedSpan[] }> = {}
  for (const inst of model.instances) {
    if (hidden.has(inst.id)) continue
    services[inst.id] = { spans: inst.rootSpans.map(exportSpan) }
  }
  return {
    format: 'tracer.trace',
    version: 1,
    ...(source === undefined ? {} : { source }),
    traceId: model.traceId,
    startTime: new Date(model.startUnixMs).toISOString(),
    durationMs: ms(model.durationNs),
    services,
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`)
  }
  return value
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${label} must be a string`)
  return value
}

function attrs(value: unknown, label: string): Attributes {
  if (value === undefined) return {}
  const raw = object(value, label)
  const out: Attributes = {}
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error(`${label}.${key} must be a string, number, or boolean`)
    }
    out[key] = item
  }
  return out
}

/** Parse either the current versioned export or the legacy unversioned shape. */
export function importTraceExport(value: unknown): TraceModel {
  const raw = object(value, 'export')
  if (raw.format !== undefined && raw.format !== 'tracer.trace') {
    throw new Error(`unsupported export format ${String(raw.format)}`)
  }
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error(`unsupported export version ${String(raw.version)}`)
  }
  const traceId = text(raw.traceId, 'traceId')
  const startTime = text(raw.startTime, 'startTime')
  const startUnixMs = Date.parse(startTime)
  if (!Number.isFinite(startUnixMs)) throw new Error('startTime must be an ISO-8601 timestamp')
  const durationNs = finite(raw.durationMs, 'durationMs') * 1e6
  const services = object(raw.services, 'services')
  const spans = new Map<string, SpanNode>()
  const events: SpanEvent[] = []
  const instances: Instance[] = []

  const makeSpan = (
    value: unknown,
    instanceId: string,
    parentSpanId: string | null,
    depth: number,
    path: string,
  ): SpanNode => {
    const item = object(value, path)
    const spanId = text(item.spanId, `${path}.spanId`)
    if (spans.has(spanId)) throw new Error(`${path}.spanId duplicates ${spanId}`)
    const status = item.status === undefined ? 'unset' : item.status
    if (status !== 'unset' && status !== 'ok' && status !== 'error') {
      throw new Error(`${path}.status must be ok or error`)
    }
    const level = item.level === undefined ? null : item.level
    if (level !== null && !['trace', 'debug', 'info', 'warn', 'error'].includes(String(level))) {
      throw new Error(`${path}.level is invalid`)
    }
    const node: SpanNode = {
      spanId,
      parentSpanId,
      traceId,
      name: text(item.name, `${path}.name`),
      kind: 'unspecified',
      startNs: finite(item.startOffsetMs, `${path}.startOffsetMs`) * 1e6,
      durationNs: finite(item.durationMs, `${path}.durationMs`) * 1e6,
      attributes: attrs(item.attributes, `${path}.attributes`),
      events: [],
      status,
      statusMessage: typeof item.statusMessage === 'string' ? item.statusMessage : '',
      level: level as Level | null,
      instanceId,
      children: [],
      depth,
    }
    spans.set(spanId, node)
    if (item.events !== undefined) {
      if (!Array.isArray(item.events)) throw new Error(`${path}.events must be an array`)
      node.events = item.events.map((eventValue, index) => {
        const event = object(eventValue, `${path}.events[${index}]`)
        const eventLevel = event.level === undefined ? null : event.level
        if (eventLevel !== null && !['trace', 'debug', 'info', 'warn', 'error'].includes(String(eventLevel))) {
          throw new Error(`${path}.events[${index}].level is invalid`)
        }
        const out: SpanEvent = {
          name: text(event.name, `${path}.events[${index}].name`),
          timeNs: finite(event.offsetMs, `${path}.events[${index}].offsetMs`) * 1e6,
          attributes: attrs(event.attributes, `${path}.events[${index}].attributes`),
          level: eventLevel as Level | null,
          spanId,
          instanceId,
        }
        events.push(out)
        return out
      })
    }
    if (item.children !== undefined) {
      if (!Array.isArray(item.children)) throw new Error(`${path}.children must be an array`)
      node.children = item.children.map((child, index) =>
        makeSpan(child, instanceId, spanId, depth + 1, `${path}.children[${index}]`),
      )
    }
    return node
  }

  for (const [instanceId, serviceValue] of Object.entries(services)) {
    const service = object(serviceValue, `services.${instanceId}`)
    if (!Array.isArray(service.spans)) throw new Error(`services.${instanceId}.spans must be an array`)
    const roots = service.spans.map((span, index) =>
      makeSpan(span, instanceId, null, 0, `services.${instanceId}.spans[${index}]`),
    )
    const hash = instanceId.indexOf('#')
    const serviceName = hash < 0 ? instanceId : instanceId.slice(0, hash)
    instances.push({
      id: instanceId,
      serviceName,
      instanceTag: hash < 0 ? null : instanceId.slice(hash + 1),
      colorIndex: colorIndexForService(serviceName),
      spanCount: [...spans.values()].filter((span) => span.instanceId === instanceId).length,
      rootSpans: roots,
      maxDepth: roots.reduce((max, root) => {
        const stack = [root]
        while (stack.length > 0) {
          const span = stack.pop()
          if (span === undefined) continue
          max = Math.max(max, span.depth)
          stack.push(...span.children)
        }
        return max
      }, 0),
    })
  }
  events.sort((a, b) => a.timeNs - b.timeNs)
  return { traceId, startUnixMs, durationNs, instances, spans, events, warnings: [] }
}
