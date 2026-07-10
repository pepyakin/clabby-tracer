import { describe, expect, test } from 'bun:test'
import { DEFAULT_REFRESH_SECONDS } from './range'

describe('search refresh', () => {
  test('defaults to manual refresh', () => {
    expect(DEFAULT_REFRESH_SECONDS).toBe(0)
  })
})
