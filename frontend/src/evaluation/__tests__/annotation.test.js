import { describe, it, expect } from 'vitest'
import { parseOffset, formatOffset, intervalFromForm, isoToOffset } from '../annotation'

const START = '2026-03-01T09:00:00.000Z'

describe('offsets', () => {
  it('parses seconds, m:ss and h:mm:ss', () => {
    expect(parseOffset('75')).toBe(75)
    expect(parseOffset('1:15')).toBe(75)
    expect(parseOffset('0:01:15')).toBe(75)
    expect(parseOffset('1:15.5')).toBe(75.5)
    expect(parseOffset('  ')).toBeNull()
    for (const bad of ['1:75', 'abc', '-5', '1:2:3:4']) expect(parseOffset(bad)).toBeNaN()
  })
  it('formats round-trip', () => {
    expect(formatOffset(75)).toBe('1:15')
    expect(formatOffset(3675)).toBe('1:01:15')
    expect(formatOffset(75.5)).toBe('1:15.5')
    expect(parseOffset(formatOffset(3675))).toBe(3675)
    expect(formatOffset(null)).toBe('')
  })
})

describe('intervalFromForm', () => {
  it('builds timestamps relative to the session start', () => {
    const { errors, value } = intervalFromForm({ category: 'object', start: '1:00', end: '1:20', label: ' cell phone ' }, START)
    expect(errors).toEqual([])
    expect(value).toEqual({ category: 'object', starts_at: '2026-03-01T09:01:00.000Z', ends_at: '2026-03-01T09:01:20.000Z', label: 'cell phone', notes: null })
    expect(isoToOffset(START, value.ends_at)).toBe(80)
  })
  it('allows instantaneous behaviour (no end)', () => {
    expect(intervalFromForm({ category: 'tab_switch', start: '30' }, START).value.ends_at).toBeNull()
  })
  it('reports every problem', () => {
    expect(intervalFromForm({ category: '', start: '', end: 'x' }, START).errors).toHaveLength(3)
    expect(intervalFromForm({ category: 'speech', start: '50', end: '40' }, START).errors).toEqual(['End must not be before start.'])
  })
})
