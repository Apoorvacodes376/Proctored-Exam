// Phase 6 research-evaluation storage: ground truth, identity labels,
// latency measurements, model cards, and the review-independent score.

import { describe, it, expect, beforeAll } from 'vitest'
import { createFixture, ID } from './fixtures'

let fx
const q = (sql, params = []) => fx.db.query(sql, params)
const one = async p => (await p).rows[0]
const rejects = (p, re = /./) => expect(p).rejects.toThrow(re)
const RLS = /row-level security|permission denied/

beforeAll(async () => {
  fx = await createFixture()
  // Alice's session is closed so it can be evaluated.
  await q(`update public.exam_sessions set status = 'submitted', submitted_at = started_at + interval '1 hour' where id = $1`, [fx.alice.examSession])
})

describe('ground-truth trials', () => {
  let trial
  it('the exam owner annotates a session; exam and author are stamped by the server', async () => {
    trial = (await one(fx.as('faculty',
      `insert into public.evaluation_trials (exam_session_id, exam_id, data_kind, annotated_categories, annotation_method, created_by)
       values ($1, $2, 'scripted', '{object,tab_switch}', 'scripted protocol v1', $3) returning id, exam_id, created_by`,
      [fx.alice.examSession, '00000000-0000-0000-0000-000000000000', ID.other])))
    expect(trial).toMatchObject({ exam_id: fx.exam, created_by: ID.faculty })
    await fx.as('faculty', `insert into public.ground_truth_intervals (trial_id, category, starts_at, ends_at, label)
                            values ($1, 'object', now(), now() + interval '20 seconds', 'cell phone')`, [trial.id])
  })

  it('rejects unknown categories, provenance values and reversed intervals', async () => {
    await rejects(fx.as('faculty', `update public.evaluation_trials set annotated_categories = '{gaze}' where id = $1`, [trial.id]), /check/)
    await rejects(fx.as('faculty', `update public.evaluation_trials set data_kind = 'synthetic-ish' where id = $1`, [trial.id]), /check/)
    await rejects(fx.as('faculty', `insert into public.ground_truth_intervals (trial_id, category, starts_at, ends_at)
                                    values ($1, 'object', now(), now() - interval '1 second')`, [trial.id]), /ground_truth_intervals_order/)
  })

  it('other faculty and students cannot see or add ground truth', async () => {
    for (const who of ['other', 'alice']) {
      expect((await fx.as(who, 'select * from public.evaluation_trials')).rows).toEqual([])
      expect((await fx.as(who, 'select * from public.ground_truth_intervals')).rows).toEqual([])
      await rejects(fx.as(who, `insert into public.ground_truth_intervals (trial_id, category, starts_at) values ($1, 'object', now())`, [trial.id]), RLS)
    }
    await rejects(fx.as('other', `insert into public.evaluation_trials (exam_session_id, exam_id, data_kind) values ($1, $2, 'live')`,
      [fx.bob.examSession, fx.exam]), RLS)
  })
})

describe('identity ground truth', () => {
  let attempt
  beforeAll(async () => {
    attempt = (await one(q(`insert into public.identity_verifications (exam_id, student_id, result, distance, threshold)
                            values ($1, $2, 'passed', 0.41, 0.52) returning id`, [fx.exam, fx.alice.student]))).id
  })

  it('the exam owner labels an attempt genuine or impostor', async () => {
    await fx.as('faculty', `insert into public.identity_ground_truth (verification_id, exam_id, is_genuine, data_kind) values ($1, $2, false, 'scripted')`,
      [attempt, '00000000-0000-0000-0000-000000000000'])
    expect(await one(q('select exam_id, labelled_by, is_genuine from public.identity_ground_truth where verification_id = $1', [attempt])))
      .toEqual({ exam_id: fx.exam, labelled_by: ID.faculty, is_genuine: false })
  })

  it('nobody else can read or write labels', async () => {
    for (const who of ['other', 'alice']) {
      expect((await fx.as(who, 'select * from public.identity_ground_truth')).rows).toEqual([])
      await rejects(fx.as(who, `update public.identity_ground_truth set is_genuine = true where verification_id = $1 returning 1`, [attempt])
        .then(r => { if (!r.rows.length) throw new Error('row-level security: no rows') }), RLS)
    }
  })
})

describe('latency measurements', () => {
  const row = `(exam_session_id, module, samples, mean_ms, p50_ms, p95_ms, max_ms, window_started_at, window_ended_at, device)
               values ($1, 'face', 30, 42.5, 40, 61, 80, now() - interval '1 minute', now(), '{"cores":8}')`

  it("students report only for their own in-progress session", async () => {
    await fx.as('bob', `insert into public.monitoring_performance ${row}`, [fx.bob.examSession])
    await rejects(fx.as('bob', `insert into public.monitoring_performance ${row}`, [fx.alice.examSession]), RLS)
    await rejects(fx.as('alice', `insert into public.monitoring_performance ${row}`, [fx.alice.examSession]), RLS)   // submitted
    expect((await fx.as('bob', 'select * from public.monitoring_performance')).rows).toEqual([])
  })

  it('values are validated and the exam is stamped', async () => {
    await rejects(fx.as('bob', `insert into public.monitoring_performance
      (exam_session_id, module, samples, mean_ms, p50_ms, p95_ms, max_ms, window_started_at, window_ended_at)
      values ($1, 'face', 0, -1, 0, 0, 0, now(), now())`, [fx.bob.examSession]), /check/)
    const r = await one(fx.as('faculty', 'select exam_id, module, samples from public.monitoring_performance'))
    expect(r).toEqual({ exam_id: fx.exam, module: 'face', samples: 30 })
    expect((await fx.as('other', 'select * from public.monitoring_performance')).rows).toEqual([])
  })
})

describe('model cards', () => {
  const card = JSON.stringify({ labelled_sessions: 60, cross_validation: { folds: 5 }, status: 'experimental' })

  it('faculty import cards for their own exams (or unscoped); others cannot see them', async () => {
    await fx.as('faculty', 'insert into public.model_evaluations (exam_id, card) values ($1, $2)', [fx.exam, card])
    await fx.as('faculty', 'insert into public.model_evaluations (card) values ($1)', [card])
    expect((await fx.as('faculty', 'select * from public.model_evaluations')).rows).toHaveLength(2)
    expect((await fx.as('other', 'select * from public.model_evaluations')).rows).toHaveLength(0)
    await rejects(fx.as('other', 'insert into public.model_evaluations (exam_id, card) values ($1, $2)', [fx.exam, card]), RLS)
    await rejects(fx.as('alice', 'insert into public.model_evaluations (card) values ($1)', [card]), RLS)
    await rejects(fx.as('faculty', 'insert into public.model_evaluations (card) values ($1)', ['{"model":"x"}']), /check/)
  })
})

describe('risk_evaluation_data', () => {
  it('scores closed sessions with faculty dismissals ignored, alongside the live score and outcome', async () => {
    const ps = fx.alice.ps
    const ev = (await one(q(`insert into public.proctoring_events (proctoring_session_id, event_type, severity, confidence, occurred_at)
                             values ($1, 'phone_detected', 'high', 0.9, $2) returning id`, [ps, '2026-01-01T10:05:00Z']))).id
    await fx.as('faculty', `insert into public.faculty_reviews (proctoring_event_id, reviewed_by, decision) values ($1, $2, 'dismissed')`, [ev, ID.faculty])
    await fx.as('faculty', `insert into public.session_reviews (exam_session_id, exam_id, status, outcome, explanation)
                            values ($1, $2, 'cleared', 'no_misconduct', 'Phone was a calculator; checked evidence.')`, [fx.alice.examSession, fx.exam])

    const { rows } = await fx.as('faculty', 'select * from public.risk_evaluation_data($1)', [fx.exam])
    expect(rows).toHaveLength(1)                      // Bob's session is still in progress
    const r = rows[0]
    expect(Number(r.live_score)).toBe(0)              // the dismissal removes it from the live score
    expect(Number(r.score_without_reviews)).toBeGreaterThan(0)
    expect(r.outcome).toBe('no_misconduct')
    expect(r.breakdown_without_reviews.ignores_reviews).toBe(true)
    expect(r.breakdown_without_reviews.events).toBeUndefined()
  })

  it('the live score is unchanged by Phase 6 (same breakdown as with reviews applied)', async () => {
    const live = await one(q('select public.compute_risk_breakdown($1, $2) as b', [fx.alice.examSession, '2026-01-01T12:00:00Z']))
    const ex = await one(q('select public.compute_risk_breakdown_ex($1, $2, false) as b', [fx.alice.examSession, '2026-01-01T12:00:00Z']))
    expect(live.b).toEqual(ex.b)
    expect(live.b.categories.objects.dismissed).toBe(1)
  })

  it('is limited to the exam owner', async () => {
    await rejects(fx.as('other', 'select * from public.risk_evaluation_data($1)', [fx.exam]), /not allowed/)
    await rejects(fx.as('alice', 'select * from public.risk_evaluation_data($1)', [fx.exam]), /not allowed/)
  })
})

describe('idempotency', () => {
  it('the Phase 6 files can be re-run', async () => {
    const { read } = await import('./supabase')
    await fx.db.exec(read('phase6_research_evaluation.sql'))
    await fx.db.exec(read('phase6_patch_integrity_evaluation.sql'))
    expect((await q('select count(*)::int as n from public.evaluation_trials')).rows[0].n).toBe(1)
  })
})
