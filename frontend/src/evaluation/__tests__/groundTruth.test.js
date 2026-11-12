// Fixtures here are hand-written test inputs that exercise the matching
// rules. They are not experimental data.

import { describe, it, expect } from 'vitest'
import { matchCategory, evaluateDetectors, trialSeconds } from '../groundTruth'

const T0 = Date.parse('2026-03-01T09:00:00Z')
const at = s => new Date(T0 + s * 1000).toISOString()
const ev = (type, start, end = null, metadata = null, session = 's1') =>
  ({ exam_session_id: session, event_type: type, occurred_at: at(start), ended_at: end == null ? null : at(end), metadata })
const gt = (category, start, end = null, label = null, trial = 't1') =>
  ({ trial_id: trial, category, starts_at: at(start), ends_at: end == null ? null : at(end), label })

describe('matchCategory', () => {
  it('matches overlapping spans and counts unmatched alerts as false alerts', () => {
    const r = matchCategory([gt('face_absence', 10, 30)], [ev('face_not_detected', 12, 29), ev('face_not_detected', 200, 215)], { toleranceS: 3 })
    expect(r).toMatchObject({ gt: 1, gtDetected: 1, events: 2, matched: 1 })
    expect(r.delaysS).toEqual([2])
  })

  it('applies the tolerance either side', () => {
    const intervals = [gt('tab_switch', 100)]   // instantaneous
    expect(matchCategory(intervals, [ev('tab_switch', 101)], { toleranceS: 1 }).matched).toBe(1)
    expect(matchCategory(intervals, [ev('tab_switch', 102.5)], { toleranceS: 1 }).matched).toBe(0)
    expect(matchCategory(intervals, [ev('tab_switch', 99)], { toleranceS: 1 }).delaysS).toEqual([-1])
  })

  it('leaves ground truth shorter than the detector minimum out of recall, but does not punish alerts on it', () => {
    const r = matchCategory([gt('face_absence', 10, 14), gt('face_absence', 50, 80)],
      [ev('face_not_detected', 11, 14)], { toleranceS: 0, minDurationS: 8 })
    expect(r).toMatchObject({ gt: 1, gtExcludedShort: 1, gtDetected: 0, matched: 1 })
  })

  it('requires matching object labels when both are known', () => {
    const intervals = [gt('object', 10, 20, 'cell phone')]
    expect(matchCategory(intervals, [ev('object_detected', 12, null, { class_name: 'book' })]).matched).toBe(0)
    expect(matchCategory(intervals, [ev('phone_detected', 12, null, { class_name: 'Cell Phone' })]).matched).toBe(1)
    expect(matchCategory(intervals, [ev('object_detected', 12, null, { class_name: 'book' })], { matchLabels: false }).matched).toBe(1)
  })

  it('one alert spanning two intervals detects both', () => {
    const r = matchCategory([gt('speech', 10, 12), gt('speech', 14, 16)], [ev('speech_detected', 9, 17)])
    expect(r).toMatchObject({ gt: 2, gtDetected: 2, matched: 1, events: 1 })
  })
})

describe('evaluateDetectors', () => {
  const session = { started_at: at(0), submitted_at: at(3600) }
  const trials = [
    { id: 't1', exam_session_id: 's1', data_kind: 'scripted', annotated_categories: ['object', 'tab_switch'], session },
    { id: 't2', exam_session_id: 's2', data_kind: 'simulated', annotated_categories: ['object'], session },
  ]
  const intervals = [
    gt('object', 100, 130, 'cell phone'), gt('object', 600, 620, 'book'), gt('tab_switch', 900),
    gt('object', 100, 130, null, 't2'),
  ]
  const events = [
    ev('phone_detected', 105, null, { class_name: 'cell phone' }),
    ev('object_detected', 2000, null, { class_name: 'book' }),     // false alert
    ev('tab_switch', 900.5),
    ev('face_not_detected', 50, 60),                                 // category not annotated: ignored
    ev('phone_detected', 101, null, null, 's2'),
  ]
  const rows = evaluateDetectors(trials, intervals, events)

  it('produces one row per data kind and annotated category, never pooling kinds', () => {
    expect(rows.map(r => `${r.data_kind}/${r.category}`)).toEqual(['scripted/object', 'scripted/tab_switch', 'simulated/object'])
  })

  it('computes precision, recall, F1 and false alerts per annotated hour', () => {
    const obj = rows[0]
    expect(obj).toMatchObject({ ground_truth: 2, detected: 1, missed: 1, alerts: 2, matched_alerts: 1, false_alerts: 1 })
    expect(obj.precision.value).toBe(0.5)
    expect(obj.recall.value).toBe(0.5)
    expect(obj.f1).toBe(0.5)
    expect(obj.false_alerts_per_hour).toBe(1)
    expect(obj.detection_delay_s.median).toBe(5)
    expect(rows[1].recall.value).toBe(1)
  })

  it('ignores unannotated categories (unknown is not "nothing happened")', () => {
    expect(rows.find(r => r.category === 'face_absence')).toBeUndefined()
  })

  it('measures an open session up to its last activity', () => {
    expect(trialSeconds({ session: { started_at: at(0), submitted_at: null } }, [ev('tab_switch', 40, 70)], [gt('tab_switch', 90)])).toBe(90)
  })
})
