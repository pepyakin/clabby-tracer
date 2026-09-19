import type { SpanNode } from './model'

/** Ownership must be explicit; never infer it from an event or a parent span. */
export function spanSubsystem(span: Pick<SpanNode, 'name' | 'attributes'>): string | null {
  for (const key of ['subsystem', 'code.namespace', 'code.namespace.name', 'target']) {
    const value = span.attributes[key]
    if (typeof value === 'string' && value.trim() !== '') return normalize(value)
  }
  // A qualified span name is useful without metadata; a bare operation name isn't.
  return span.name.includes('::') ? normalize(span.name) : null
}

function normalize(value: string): string {
  return value.trim().split(/::|[./]/).filter(Boolean).slice(0, 2).join('::')
}

/**
 * Equally spaced families, with narrow component hue variations. Build from the
 * whole trace so hiding lanes, searching, and focusing never change its colors.
 * Palette parameters come from theme tokens, not workload-specific rules.
 */
export function subsystemPalette(
  paths: Iterable<string>,
  startHue: number,
  spread: number,
): Map<string, number> {
  const unique = [...new Set(paths)].sort()
  const families = [...new Set(unique.map((path) => path.split('::')[0]))]
  const spacing = 360 / Math.max(families.length, 1)
  return new Map(unique.map((path) => {
    const [family, component] = path.split('::')
    const siblings = unique.filter((candidate) => candidate.startsWith(`${family}::`))
    const variation = component === undefined || siblings.length < 2
      ? 0 : siblings.indexOf(path) / (siblings.length - 1) - 0.5
    const hue = startHue - families.indexOf(family) * spacing
      + variation * Math.min(spread, spacing / 3)
    return [path, (hue % 360 + 360) % 360]
  }))
}
