// Triggers, live status, review workflow, security and realtime setup
// for phase5_patch_monitoring_review.sql.

import { describe, it, expect, beforeAll } from 'vitest'
import { createFixture, ID } from './fixtures'

let fx
beforeAll(async () => { fx = await createFixture() })

const storedRisk = async who =>
  (await fx.db.query('select * from public.risk_scores where exam_session_id = $1', [fx[who].examSession])).rows[0]

async function denied(p) { await expect(p).rejects.toThrow(/row-level security|permission denied|violates|not your/) }

describe('risk_scores are kept current by triggers', () => {
  it('every exam session gets a score row when it starts', async () => {
    const r = await storedRisk('bob')
    expect(r).toMatchObject({ exam_id: fx.exam, total_events: 0, needs_review: false })
    expect(Number(r.score)).toBe(0)
  })

  it('a student logging an event updates the stored score immediately', async () => {
    await fx.as('alice',
      `insert into public.proctoring_events (proctoring_session_id, event_type, severity, confidence, metadata)
       values ($1, 'phone_detected', 'critical', 0.9, '{"class_name":"cell phone"}')`, [fx.alice.ps])
    const r = await storedRisk('alice')
    expect(Number(r.score)).toBe(11.25)
    expect(r.breakdown.type_counts.phone_detected).toBe(1)
    expect(r.critical_events).toBe(1)
    expect(Number(r.overall_score)).toBeCloseTo(0.1125)
  })

  it('closing an episode updates its duration in the score', async () => {
    // Students cannot read events back, so the client generates the id (as eventLogger does).
    const evId = '20000000-0000-0000-0000-000000000001'
    await fx.as('alice',
      `insert into public.proctoring_events (id, proctoring_session_id, event_type, occurred_at)
       values ($2, $1, 'face_not_detected', now() - interval '60 seconds')`, [fx.alice.ps, evId])
    expect((await storedRisk('alice')).open_episodes).toBe(1)
    await fx.as('alice', 'select public.close_proctoring_event($1, now())', [evId])
    const r = await storedRisk('alice')
    expect(r.open_episodes).toBe(0)
    expect(r.breakdown.categories.face_absence.duration_s).toBeGreaterThanOrEqual(59)
  })

  it('the score never changes the exam session status or grade on its own', async () => {
    for (let i = 0; i < 5; i++) {
      await fx.db.query(`insert into public.proctoring_events (proctoring_session_id, event_type, severity, occurred_at, ended_at)
        values ($1, 'multiple_faces', 'critical', now() - make_interval(mins => $2 * 3), now() - make_interval(mins => $2 * 3 - 2))`, [fx.alice.ps, i + 1])
    }
    const r = await storedRisk('alice')
    expect(r.needs_review).toBe(true)
    const { rows } = await fx.db.query('select status from public.exam_sessions where id = $1', [fx.alice.examSession])
    expect(rows[0].status).toBe('in_progress')
  })

  it('changing the exam settings recomputes stored scores', async () => {
    const before = await storedRisk('alice')
    await fx.as('faculty', `insert into public.exam_risk_settings (exam_id, config) values ($1, '{"review_threshold": 95, "high_threshold": 99}')
                            on conflict (exam_id) do update set config = excluded.config`, [fx.exam])
    const after = await storedRisk('alice')
    expect(before.needs_review).toBe(true)
    expect(after.needs_review).toBe(false)
    expect(after.breakdown.review_threshold).toBe(95)
    await fx.db.query('delete from public.exam_risk_settings')
  })
})

describe('security', () => {
  it('students cannot read or write risk scores', async () => {
    expect((await fx.as('alice', 'select * from public.risk_scores')).rows).toEqual([])
    const upd = await fx.as('alice', 'update public.risk_scores set score = 0, overall_score = 0')
    expect(upd.affectedRows).toBe(0)
    await denied(fx.as('alice', `insert into public.risk_scores (exam_session_id) values ($1)`, [fx.bob.examSession]))
  })

  it('clients cannot call the internal scoring functions', async () => {
    await denied(fx.as('faculty', 'select public.compute_risk_breakdown($1)', [fx.alice.examSession]))
    await denied(fx.as('other',   'select public.update_risk_score($1)',      [fx.alice.examSession]))
  })

  it('faculty see scores only for their own exams', async () => {
    expect((await fx.as('faculty', 'select exam_session_id from public.risk_scores')).rows).toHaveLength(2)
    expect((await fx.as('other',   'select exam_session_id from public.risk_scores')).rows).toEqual([])
  })

  it('get_risk_config is limited to the exam owner', async () => {
    const { rows } = await fx.as('faculty', 'select public.get_risk_config($1) as c', [fx.exam])
    expect(rows[0].c.review_threshold).toBe(40)
    await denied(fx.as('other', 'select public.get_risk_config($1)', [fx.exam]))
  })

  it('other faculty cannot change this exam\'s settings', async () => {
    await denied(fx.as('other', `insert into public.exam_risk_settings (exam_id, config) values ($1, '{}')`, [fx.exam]))
  })
})

describe('live status heartbeats', () => {
  it('stores whitelisted fields with the server time', async () => {
    await fx.as('bob', 'select public.report_live_status($1, $2)', [fx.bob.examSession,
      JSON.stringify({ camera: 'ok', face: 'absent', away: false, injected: 'x', nested: { a: 1 } })])
    const { rows } = await fx.db.query('select live_status, last_heartbeat_at, exam_id from public.proctoring_sessions where id = $1', [fx.bob.ps])
    expect(rows[0].live_status).toEqual({ camera: 'ok', face: 'absent', away: false })
    expect(rows[0].last_heartbeat_at).toBeTruthy()
    expect(rows[0].exam_id).toBe(fx.exam)
  })

  it('rejects heartbeats for someone else\'s session', async () => {
    await denied(fx.as('alice', 'select public.report_live_status($1, $2)', [fx.bob.examSession, '{"camera":"ok"}']))
  })

  it('faculty can read live status for their exam only', async () => {
    expect((await fx.as('faculty', 'select live_status from public.proctoring_sessions where exam_id = $1', [fx.exam])).rows).toHaveLength(2)
    expect((await fx.as('other', 'select live_status from public.proctoring_sessions')).rows).toEqual([])
  })
})

describe('identity verification log', () => {
  it('students can log only their own attempts, with server time', async () => {
    await fx.as('bob', `insert into public.identity_verifications (exam_id, student_id, result, distance, threshold, attempted_at)
                        values ($1, $2, 'failed', 0.8, 0.52, '2000-01-01')`, [fx.exam, fx.bob.student])
    const { rows } = await fx.db.query('select attempted_at from public.identity_verifications where student_id = $1', [fx.bob.student])
    expect(new Date(rows[0].attempted_at).getFullYear()).toBeGreaterThan(2020)
    await denied(fx.as('alice', `insert into public.identity_verifications (exam_id, student_id, result) values ($1, $2, 'passed')`, [fx.exam, fx.bob.student]))
    expect((await fx.as('bob', 'select * from public.identity_verifications')).rows).toEqual([])
  })

  it('faculty see attempts and the identity flag on the stored score', async () => {
    await fx.as('bob', `insert into public.identity_verifications (exam_id, student_id, result) values ($1, $2, 'manual_review_requested')`, [fx.exam, fx.bob.student])
    expect((await fx.as('faculty', 'select result from public.identity_verifications where student_id = $1', [fx.bob.student])).rows).toHaveLength(2)
    const r = await storedRisk('bob')
    expect(r.identity_flag).toBe(true)
    expect(r.review_reasons).toContain('identity')
    expect(Number(r.score)).toBe(0)
  })
})

describe('faculty review workflow', () => {
  let eventId
  beforeAll(async () => {
    eventId = (await fx.db.query(`insert into public.proctoring_events (proctoring_session_id, event_type, confidence, occurred_at, ended_at)
      values ($1, 'speech_detected', 0.7, now() - interval '40 seconds', now() - interval '10 seconds') returning id`, [fx.bob.ps])).rows[0].id
  })

  it('faculty mark events reviewed; reviewer and time are set by the server', async () => {
    await fx.as('faculty', `insert into public.faculty_reviews (proctoring_event_id, reviewed_by, decision, notes)
                            values ($1, $2, 'confirmed', 'Audible second voice on recording')`, [eventId, ID.other])
    const { rows } = await fx.db.query('select reviewed_by, reviewed_at, decision from public.faculty_reviews where proctoring_event_id = $1', [eventId])
    expect(rows[0]).toMatchObject({ reviewed_by: ID.faculty, decision: 'confirmed' })
    expect(rows[0].reviewed_at).toBeTruthy()
  })

  it('faculty cannot review events from another faculty member\'s exam', async () => {
    await denied(fx.as('other', `insert into public.faculty_reviews (proctoring_event_id, reviewed_by, decision) values ($1, $2, 'dismissed')`, [eventId, ID.other]))
    expect((await fx.as('other', 'select * from public.faculty_reviews')).rows).toEqual([])
  })

  it('a session decision needs an explanation', async () => {
    await expect(fx.as('faculty', `insert into public.session_reviews (exam_session_id, status) values ($1, 'cleared')`, [fx.bob.examSession]))
      .rejects.toThrow(/session_reviews_decision_explained/)
  })

  it('records decisions, keeps an append-only history with the score at the time', async () => {
    await fx.as('faculty', `insert into public.session_reviews (exam_session_id, exam_id, status) values ($1, $2, 'in_review')`, [fx.bob.examSession, fx.exam])
    await fx.as('faculty', `update public.session_reviews set status = 'further_review', explanation = 'Identity not confirmed; hold marks until a video call.' where exam_session_id = $1`, [fx.bob.examSession])
    await fx.as('faculty', `update public.session_reviews set status = 'cleared', outcome = 'no_misconduct', explanation = 'Confirmed identity by video call on 2 Jan.' where exam_session_id = $1`, [fx.bob.examSession])

    const hist = (await fx.as('faculty', 'select status, outcome, decided_by, score_at_decision from public.session_review_history where exam_session_id = $1 order by decided_at, status desc', [fx.bob.examSession])).rows
    expect(hist.map(h => h.status)).toEqual(['in_review', 'further_review', 'cleared'])
    expect(hist.every(h => h.decided_by === ID.faculty)).toBe(true)
    expect(hist[2].score_at_decision).not.toBeNull()

    const upd = await fx.as('faculty', `update public.session_review_history set status = 'x'`)
    expect(upd.affectedRows).toBe(0)
    const del = await fx.as('faculty', 'delete from public.session_review_history')
    expect(del.affectedRows).toBe(0)
  })

  it('other faculty cannot see or make session decisions', async () => {
    expect((await fx.as('other', 'select * from public.session_reviews')).rows).toEqual([])
    await denied(fx.as('other', `insert into public.session_reviews (exam_session_id, status) values ($1, 'in_review')`, [fx.alice.examSession]))
  })

  it('students cannot see reviews or decisions about themselves', async () => {
    expect((await fx.as('bob', 'select * from public.session_reviews')).rows).toEqual([])
    expect((await fx.as('bob', 'select * from public.faculty_reviews')).rows).toEqual([])
  })
})

describe('evidence retrieval', () => {
  it('faculty can resolve an event\'s snapshot to its private storage object', async () => {
    const path = `${fx.alice.examSession}/evidence-1.jpg`
    await fx.as('alice', `insert into storage.objects (bucket_id, name) values ('proctoring-frames', $1)`, [path])
    const snap = (await fx.db.query(`insert into public.proctoring_snapshots (proctoring_session_id, storage_path) values ($1, $2) returning id`, [fx.alice.ps, path])).rows[0].id
    const evId = (await fx.db.query(`insert into public.proctoring_events (proctoring_session_id, event_type, snapshot_id, confidence) values ($1, 'object_detected', $2, 0.7) returning id`, [fx.alice.ps, snap])).rows[0].id

    // The breakdown carries the snapshot id …
    const r = await storedRisk('alice')
    expect(r.breakdown.events.find(e => e.id === evId).snapshot_id).toBe(snap)
    // … which the exam's faculty can resolve to a path and read in storage.
    const s = await fx.as('faculty', 'select storage_path from public.proctoring_snapshots where id = $1', [snap])
    expect(s.rows[0].storage_path).toBe(path)
    expect((await fx.as('faculty', `select name from storage.objects where bucket_id = 'proctoring-frames' and name = $1`, [path])).rows).toHaveLength(1)
  })

  it('nobody else can resolve or read it', async () => {
    expect((await fx.as('other', 'select * from public.proctoring_snapshots')).rows).toEqual([])
    expect((await fx.as('other', `select * from storage.objects where bucket_id = 'proctoring-frames'`)).rows).toEqual([])
    expect((await fx.as('alice', `select * from storage.objects where bucket_id = 'proctoring-frames'`)).rows).toEqual([])
  })
})

describe('realtime publication', () => {
  it('publishes the tables the live dashboard subscribes to', async () => {
    const { rows } = await fx.db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1`)
    expect(rows.map(r => r.tablename)).toEqual([
      'exam_sessions', 'faculty_reviews', 'identity_verifications', 'proctoring_events',
      'proctoring_sessions', 'risk_scores', 'session_reviews',
    ])
  })
})

describe('compatibility', () => {
  it('phase 6 metrics still aggregate risk scores', async () => {
    await fx.db.query('select public.refresh_system_metrics($1)', [fx.exam])
    const { rows } = await fx.db.query('select avg_risk_score from public.system_metrics where exam_id = $1', [fx.exam])
    expect(rows[0].avg_risk_score).not.toBeNull()
  })

  it('the patch is idempotent', async () => {
    const { read } = await import('./supabase')
    await fx.db.exec(read('phase5_patch_monitoring_review.sql'))
    expect((await storedRisk('alice')).breakdown).toBeTruthy()
  })
})
