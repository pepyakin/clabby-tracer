import { describe, expect, test } from 'bun:test'
import { spanSubsystem, subsystemPalette } from './subsystem'

describe('subsystem ownership', () => {
  test('explicit ownership wins over target and operation name', () => {
    expect(spanSubsystem({ name: 'other::operation', attributes: {
      subsystem: ' vendor/runtime/io ', target: 'different::module',
    } })).toBe('vendor::runtime')
    expect(spanSubsystem({ name: 'execute', attributes: {
      target: 'engine::execution::worker',
    } })).toBe('engine::execution')
    expect(spanSubsystem({ name: 'execute', attributes: {
      'code.namespace': 'library.storage.journal',
    } })).toBe('library::storage')
  })

  test('qualified names work, bare names and unrelated attributes stay unknown', () => {
    expect(spanSubsystem({ name: 'library::consensus::vote', attributes: {} })).toBe('library::consensus')
    expect(spanSubsystem({ name: 'execute', attributes: { 'service.name': 'worker-2', subsystem: 42 } })).toBeNull()
    expect(spanSubsystem({ name: 'commit', attributes: { target: '  ' } })).toBeNull()
  })
})

describe('hierarchical palette', () => {
  const paths = ['commonware::runtime', 'commonware::consensus', 'tempo::payload', 'reth::execution']
  const distance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

  test('components are nearby and families contrast, including across hue zero', () => {
    const palette = subsystemPalette(paths, 5, 24)
    const runtime = palette.get(paths[0])!
    const consensus = palette.get(paths[1])!
    expect(runtime).toBe(17)
    expect(consensus).toBe(353)
    expect(palette.get('reth::execution')).toBe(245)
    expect(palette.get('tempo::payload')).toBe(125)
    expect(distance(runtime, consensus)).toBeLessThanOrEqual(24)
    expect(distance(runtime, palette.get(paths[2])!)).toBeGreaterThan(96)
    expect(distance(runtime, palette.get(paths[3])!)).toBeGreaterThan(96)
    expect(distance(palette.get(paths[2])!, palette.get(paths[3])!)).toBeGreaterThan(96)
    for (const hue of palette.values()) {
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })

  test('ordering and duplicate spans do not change colors', () => {
    expect(subsystemPalette([...paths].reverse().concat(paths[0]), 170, 24))
      .toEqual(subsystemPalette(paths, 170, 24))
    expect(subsystemPalette([], 170, 24).size).toBe(0)
    expect(subsystemPalette(['vendor'], 170, 24).get('vendor')).toBe(170)
  })

  test('component variation contracts when there are many families', () => {
    const many = Array.from({ length: 30 }, (_, i) => `family${i}::runtime`)
    many.push('family0::consensus')
    const palette = subsystemPalette(many, 170, 24)
    expect(distance(palette.get('family0::runtime')!, palette.get('family0::consensus')!))
      .toBeLessThanOrEqual(4)
  })
})
