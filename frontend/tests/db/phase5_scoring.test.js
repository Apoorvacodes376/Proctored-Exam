// Risk-score calculation tests for compute_risk_breakdown() using the
// default configuration (weights: face 20, people 25, objects 25, tab 15,
// audio 10, media 5 — sum 100, so score = Σ weight × normalised).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createFixture } from './fixtures'

let fx
beforeAll(async () => { fx = await createFixture() })
beforeEach(async () => { await fx.clearEvents('alice') })

const cat = (b, name) => b.categories[name]
const ev  = (b, id) => b.events.find(e => e.id === id)

describe('compute_risk_breakdown — basics', () => {
  it('a clean session scores 0 and needs no review', async () => {
    const b = await fx.breakdown('alice')
    expect(b.score).toBe(0)
    expect(b.level).toBe('low')
    expect(b.needs_review).toBe(false)
    expect(b.review_reasons).toEqual([])
  })

  it('weights confidence and normalises by saturation (one phone at 0.9)', async () => {
    await fx.event('alice', 'phone_detected', { at: 60, confidence: 0.9, metadata: { class_name: 'cell phone' } })
    const b = await fx.breakdown('alice')
    // effective 0.9 / saturation 2 = 0.45 → 25 × 0.45 = 11.25
    expect(cat(b, 'objects')).toMatchObject({ counted: 1, effective: 0.9, normalised: 0.45, contribution: 11.25 })
    expect(b.score).toBe(11.25)
  })

  it('caps each category at its weight (saturation)', async () => {
    for (let i = 0; i < 6; i++) {
      await fx.event('alice', 'phone_detected', { at: i * 120, confidence: 0.95, metadata: { class_name: 'cell phone' } })
    }
    const b = await fx.breakdown('alice')
    expect(cat(b, 'objects').normalised).toBe(1)
    expect(cat(b, 'objects').contribution).toBe(25)
    expect(b.score).toBe(25)
  })

  it('reaches exactly 100 only when every category is saturated', async () => {
    const types = [
      ['face_not_detected', 600], ['multiple_faces', 600], ['tab_switch', 600],
      ['speech_detected', 600], ['camera_interrupted', 600],
    ]
    for (const [t, dur] of types) await fx.event('alice', t, { at: 0, dur })
    for (let i = 0; i < 3; i++) await fx.event('alice', 'phone_detected', { at: i * 100, metadata: { class_name: 'cell phone' } })
    const b = await fx.breakdown('alice')
    expect(b.score).toBe(100)
    expect(b.level).toBe('critical')
  })
})

describe('compute_risk_breakdown — duration', () => {
  it('adds one unit per seconds_per_unit of a closed episode', async () => {
    await fx.event('alice', 'face_not_detected', { at: 100, dur: 60 })
    const b = await fx.breakdown('alice')
    // 1 × (1 + 60/30) = 3 → 3/4 = 0.75 → 20 × 0.75 = 15
    expect(cat(b, 'face_absence')).toMatchObject({ effective: 3, duration_s: 60, contribution: 15 })
  })

  it('counts an open episode up to "now", and reports it as open', async () => {
    const id = await fx.event('alice', 'face_not_detected', { at: 100 })
    const b = await fx.breakdown('alice', 100 + 90)
    expect(ev(b, id).duration_s).toBe(90)
    expect(b.open_episodes).toBe(1)
    expect(cat(b, 'face_absence').contribution).toBe(20)   // 1 + 90/30 = 4 → saturated
  })

  it('stops an open episode at submission time', async () => {
    const id = await fx.event('alice', 'face_not_detected', { at: 100 })
    await fx.db.query(`update public.exam_sessions set submitted_at = $2, status = 'submitted' where id = $1`,
      [fx.alice.examSession, new Date(Date.parse('2026-01-01T10:00:00Z') + 130_000).toISOString()])
    const b = await fx.breakdown('alice', 3600)
    expect(ev(b, id).duration_s).toBe(30)
    await fx.db.query(`update public.exam_sessions set submitted_at = null, status = 'in_progress' where id = $1`, [fx.alice.examSession])
  })

  it('caps very long episodes at max_episode_s', async () => {
    const id = await fx.event('alice', 'tab_switch', { at: 0, dur: 7200 })
    const b = await fx.breakdown('alice')
    expect(ev(b, id).duration_s).toBe(600)
  })

  it('ignores duration where seconds_per_unit is 0 (objects)', async () => {
    await fx.event('alice', 'object_detected', { at: 0, dur: 500, metadata: { class_name: 'book' } })
    const b = await fx.breakdown('alice')
    expect(cat(b, 'objects').effective).toBe(0.6)        // type factor only
  })
})

describe('compute_risk_breakdown — duplicates, dismissals, confidence', () => {
  it('merges a repeat within the dedupe window: no extra count, duration still added', async () => {
    const a = await fx.event('alice', 'face_not_detected', { at: 0,  dur: 15 })
    const b2 = await fx.event('alice', 'face_not_detected', { at: 25, dur: 15 })   // 10 s after the first ended
    const b = await fx.breakdown('alice')
    expect(ev(b, a).status).toBe('counted')
    expect(ev(b, b2).status).toBe('duplicate')
    // counted: 1 + 15/30 = 1.5; duplicate: 15/30 = 0.5 → 2.0
    expect(cat(b, 'face_absence')).toMatchObject({ counted: 1, duplicates: 1, effective: 2 })
  })

  it('counts a repeat outside the window as a new occurrence', async () => {
    await fx.event('alice', 'tab_switch', { at: 0,   dur: 3 })
    await fx.event('alice', 'tab_switch', { at: 120, dur: 3 })
    const b = await fx.breakdown('alice')
    expect(cat(b, 'tab_switching')).toMatchObject({ counted: 2, duplicates: 0, effective: 2.2 })
  })

  it('de-duplicates objects per class: a book does not merge into a phone', async () => {
    await fx.event('alice', 'phone_detected',  { at: 0, metadata: { class_name: 'cell phone' } })
    await fx.event('alice', 'phone_detected',  { at: 5, metadata: { class_name: 'cell phone' } })
    await fx.event('alice', 'object_detected', { at: 6, metadata: { class_name: 'book' } })
    const b = await fx.breakdown('alice')
    expect(cat(b, 'objects')).toMatchObject({ counted: 2, duplicates: 1 })
  })

  it('excludes events below min_confidence but still lists them', async () => {
    const id = await fx.event('alice', 'phone_detected', { confidence: 0.2, metadata: { class_name: 'cell phone' } })
    const b = await fx.breakdown('alice')
    expect(ev(b, id).status).toBe('below_confidence')
    expect(b.score).toBe(0)
    expect(cat(b, 'objects').below_confidence).toBe(1)
  })

  it('excludes events a faculty member dismissed', async () => {
    const id = await fx.event('alice', 'multiple_faces', { at: 0, dur: 30, confidence: 0.8 })
    expect((await fx.breakdown('alice')).score).toBeGreaterThan(0)
    await fx.as('faculty', `insert into public.faculty_reviews (proctoring_event_id, reviewed_by, decision, notes)
                            values ($1, $2, 'dismissed', 'Reflection of the student in a window')`,
      [id, '00000000-0000-0000-0000-0000000000f1'])
    const b = await fx.breakdown('alice')
    expect(ev(b, id)).toMatchObject({ status: 'dismissed', decision: 'dismissed' })
    expect(b.score).toBe(0)
  })

  it('lists types that are not in any category without scoring them', async () => {
    const id = await fx.event('alice', 'copy_paste')
    const b = await fx.breakdown('alice')
    expect(ev(b, id).status).toBe('not_scored')
    expect(b.score).toBe(0)
    expect(b.type_counts.copy_paste).toBe(1)
  })

  it('applies per-type factors (focus_lost = 0.5 of a tab switch)', async () => {
    await fx.event('alice', 'focus_lost', { at: 0, dur: 0 })
    const b = await fx.breakdown('alice')
    expect(cat(b, 'tab_switching').effective).toBe(0.5)
  })
})

describe('identity verification is reported separately', () => {
  const attempt = (result, distance = null) => fx.db.query(
    'insert into public.identity_verifications (exam_id, student_id, result, distance, threshold) values ($1, $2, $3, $4, 0.52)',
    [fx.exam, fx.alice.student, result, distance])

  it('repeated failures flag the session for review without changing the score', async () => {
    await attempt('failed', 0.81); await attempt('inconclusive', 0.6); await attempt('passed', 0.47)
    const b = await fx.breakdown('alice')
    expect(b.score).toBe(0)
    expect(b.identity).toMatchObject({ attempts: 3, failed: 1, inconclusive: 1, passed: 1, flag: true, reasons: ['repeated_failures'] })
    expect(b.needs_review).toBe(true)
    expect(b.review_reasons).toEqual(['identity'])
  })

  it('a clean pass raises no identity flag', async () => {
    await attempt('passed', 0.4)
    const b = await fx.breakdown('alice')
    expect(b.identity.flag).toBe(false)
    expect(b.needs_review).toBe(false)
  })

  it('a manual-review request is flagged with its own reason', async () => {
    await attempt('manual_review_requested')
    const b = await fx.breakdown('alice')
    expect(b.identity.reasons).toEqual(expect.arrayContaining(['manual_review_requested', 'never_passed']))
  })

  it('distinguishes behavioural and identity reasons when both apply', async () => {
    await attempt('manual_review_requested')
    for (let i = 0; i < 3; i++) await fx.event('alice', 'phone_detected', { at: i * 100, metadata: { class_name: 'cell phone' } })
    await fx.event('alice', 'multiple_faces', { at: 10, dur: 120 })
    const b = await fx.breakdown('alice')
    expect(b.review_reasons).toEqual(['risk_score', 'identity'])
  })
})

describe('configurable thresholds and weights', () => {
  it('per-exam review threshold changes needs_review and level', async () => {
    await fx.event('alice', 'phone_detected', { confidence: 0.9, metadata: { class_name: 'cell phone' } })
    expect((await fx.breakdown('alice')).needs_review).toBe(false)          // 11.25 < 40
    await fx.as('faculty', `insert into public.exam_risk_settings (exam_id, config) values ($1, '{"review_threshold": 10, "high_threshold": 50}')`, [fx.exam])
    const b = await fx.breakdown('alice')
    expect(b).toMatchObject({ needs_review: true, review_threshold: 10, level: 'high' })
  })

  it('per-exam weights are merged onto the defaults', async () => {
    await fx.event('alice', 'phone_detected', { confidence: 0.9, metadata: { class_name: 'cell phone' } })
    await fx.as('faculty', `insert into public.exam_risk_settings (exam_id, config) values ($1, '{"categories": {"objects": {"saturation": 1}}}')`, [fx.exam])
    const b = await fx.breakdown('alice')
    expect(cat(b, 'objects')).toMatchObject({ weight: 25, saturation: 1, normalised: 0.9 })
    expect(b.config.categories.face_absence.weight).toBe(20)
  })

  it('rejects invalid configurations', async () => {
    for (const bad of [
      '{"review_threshold": 80, "high_threshold": 50}',
      '{"categories": {"objects": {"weight": -5}}}',
      '{"categories": {"objects": {"saturation": 0}}}',
      '{"min_confidence": 2}',
      '{"categories": {"objects": {"types": {"phone_detected": 3}}}}',
    ]) {
      await expect(fx.as('faculty', 'insert into public.exam_risk_settings (exam_id, config) values ($1, $2)', [fx.exam, bad]))
        .rejects.toThrow(/exam_risk_settings_config_valid/)
    }
  })

  it('risk_config_errors explains what is wrong', async () => {
    const { rows } = await fx.db.query(`select public.risk_config_errors('{"review_threshold": 120}'::jsonb) as e`)
    expect(rows[0].e.join(' ')).toMatch(/review_threshold/)
    const ok = await fx.db.query('select public.risk_config_errors(public.default_risk_config()) as e')
    expect(ok.rows[0].e).toEqual([])
  })
})
