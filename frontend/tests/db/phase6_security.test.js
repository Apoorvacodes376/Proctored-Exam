// Phase 6 end-to-end database tests: authentication & roles, assignment &
// scheduling, identity verification, answer saving & automatic submission,
// monitoring alerts & evidence, and unauthorized-access prevention —
// all against the real migrations (see fixtures.js).

import { describe, it, expect, beforeAll } from 'vitest'
import { createFixture, ID } from './fixtures'
import { runAs } from './supabase'

const CAROL = '00000000-0000-0000-0000-0000000000c1'   // signed-up student, assigned to nothing
let fx

/** Run as a fixture user, as carol, as anon (no JWT) — or as the superuser (null). */
function as(who, sql, params = []) {
  if (who === 'carol') return runAs(fx.db, { sub: CAROL, email: 'carol@uni.test' }, sql, params)
  if (who === 'anon') return asAnon(sql, params)
  return fx.as(who, sql, params)
}
async function asAnon(sql, params) {
  await fx.db.exec('set role anon')
  try { return await fx.db.query(sql, params) } finally { await fx.db.exec('reset role') }
}
const q = (sql, params = []) => fx.db.query(sql, params)
const one = async (p) => (await p).rows[0]
const rejects = (p, re = /./) => expect(p).rejects.toThrow(re)
const RLS = /row-level security|permission denied/

/**
 * A new exam owned by `faculty`, starting `startsInMin` minutes from now
 * (in `tz`, or with no time zone), with one MCQ worth 2 and one
 * descriptive question worth 5. Alice and Bob are assigned.
 */
async function newExam({ tz = null, startsInMin = -5, duration = 60 } = {}) {
  const exam = (await one(q(
    `insert into public.exams (faculty_id, title, subject, exam_date, start_time, duration_mins, total_marks, time_zone)
     select $1, 'Physics', 'Sci', x::date, x::time, $3, 7, $4
     from (select (now() + make_interval(mins => $2)) at time zone coalesce($4, 'UTC') as x) s
     returning id`, [ID.faculty, startsInMin, duration, tz]))).id
  const mcq = (await one(q(
    `insert into public.questions (exam_id, question_text, question_type, options, correct_answer, marks, order_index)
     values ($1, '2+2?', 'mcq', '["3","4"]', '1', 2, 0) returning id`, [exam]))).id
  const essay = (await one(q(
    `insert into public.questions (exam_id, question_text, question_type, marks, order_index)
     values ($1, 'Explain inertia', 'descriptive', 5, 1) returning id`, [exam]))).id
  const assignment = {}
  for (const who of ['alice', 'bob']) {
    assignment[who] = (await one(q(
      'insert into public.exam_assignments (exam_id, student_id) values ($1, $2) returning id', [exam, fx[who].student]))).id
  }
  return { exam, mcq, essay, assignment }
}

/** Start a session the way ExamRoom does (as the student). */
async function start(who, e, extra = {}) {
  const cols = { exam_id: e.exam, student_id: fx[who].student, assignment_id: e.assignment[who], status: 'in_progress', ...extra }
  const keys = Object.keys(cols)
  const { rows } = await as(who,
    `insert into public.exam_sessions (${keys.join(', ')}) values (${keys.map((_, i) => '$' + (i + 1)).join(', ')})
     returning id, started_at, submitted_at`, Object.values(cols))
  return rows[0]
}

const saveAnswer = (who, session, question, text, extra = '') => as(who,
  `insert into public.exam_answers (session_id, question_id, answer_text${extra ? ', is_correct, marks_awarded' : ''})
   values ($1, $2, $3${extra ? ', ' + extra : ''})
   on conflict (session_id, question_id) do update set answer_text = excluded.answer_text${extra ? ', is_correct = excluded.is_correct, marks_awarded = excluded.marks_awarded' : ''}`,
  [session, question, text])

const submit = (who, session, status = 'submitted') =>
  as(who, `update public.exam_sessions set status = $2, submitted_at = '2000-01-01' where id = $1`, [session, status])

beforeAll(async () => {
  fx = await createFixture()
  await q(`insert into auth.users (id, email) values ($1, 'carol@uni.test')`, [CAROL])
})

// ─────────────────────────────────────────────────────────────
describe('authentication and roles', () => {
  it('every sign-up becomes a student, whatever role the client asks for', async () => {
    const id = '00000000-0000-0000-0000-0000000000d1'
    await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'dave@uni.test', '{"role":"faculty","username":"dave"}')`, [id])
    expect(await one(q('select role, username from public.profiles where id = $1', [id]))).toEqual({ role: 'student', username: 'dave' })
  })

  it('users can edit their profile but cannot promote themselves', async () => {
    await as('alice', `update public.profiles set username = 'alice2' where id = $1`, [ID.alice])
    expect((await one(q('select username from public.profiles where id = $1', [ID.alice]))).username).toBe('alice2')
    await rejects(as('alice', `update public.profiles set role = 'faculty' where id = $1`, [ID.alice]), RLS)
    expect((await one(q('select role from public.profiles where id = $1', [ID.alice]))).role).toBe('student')
  })

  it('students see only their own profile; anonymous users see nothing', async () => {
    const { rows } = await as('alice', 'select id from public.profiles')
    expect(rows.map(r => r.id)).toEqual([ID.alice])
    for (const table of ['profiles', 'exams', 'students', 'questions', 'exam_sessions', 'proctoring_events', 'risk_scores']) {
      // Either no rows, or refused outright (policies that call revoked helpers).
      const n = await as('anon', `select count(*)::int as n from public.${table}`).then(r => r.rows[0].n, e => {
        expect(e.message).toMatch(/permission denied/); return 0
      })
      expect(n, table).toBe(0)
    }
  })

  it('faculty-only data is invisible to students', async () => {
    for (const table of ['risk_scores', 'session_reviews', 'faculty_reviews', 'identity_verifications',
      'proctoring_events', 'evaluation_trials', 'monitoring_performance', 'model_evaluations', 'audit_log']) {
      expect((await as('alice', `select count(*)::int as n from public.${table}`)).rows[0].n, table).toBe(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────
describe('student assignment and exam scheduling', () => {
  it('faculty assign only their own students to their own exams', async () => {
    const e = await newExam()
    const carolRecord = (await one(as('faculty',
      `insert into public.students (faculty_id, name, email, student_id) values ($1, 'Carol', 'carol@uni.test', 'CAROL') returning id`,
      [ID.faculty]))).id
    await as('faculty', 'insert into public.exam_assignments (exam_id, student_id) values ($1, $2)', [e.exam, carolRecord])
    await rejects(as('other', 'insert into public.exam_assignments (exam_id, student_id) values ($1, $2)', [fx.exam, carolRecord]), RLS)
    await q('delete from public.students where id = $1', [carolRecord])
  })

  it('students see only exams they are assigned to', async () => {
    const e = await newExam()
    const alice = (await as('alice', 'select id from public.exams')).rows.map(r => r.id)
    expect(alice).toContain(e.exam)
    expect((await as('carol', 'select id from public.exams')).rows).toEqual([])
  })

  it('a student cannot start an exam they are not assigned to', async () => {
    const e = await newExam()
    // Alice tries to use Bob's assignment, then to start on another faculty's exam
    await rejects(start('alice', { ...e, assignment: { alice: e.assignment.bob } }), /not assigned/)
  })

  it('the server sets started_at; a backdated start is ignored', async () => {
    const e = await newExam()
    const s = await start('alice', e, { started_at: '2020-01-01T00:00:00Z', submitted_at: '2020-01-01T01:00:00Z' })
    expect(Date.now() - new Date(s.started_at).getTime()).toBeLessThan(60_000)
    expect(s.submitted_at).toBeNull()
  })

  it('with a time zone set, sessions can start only inside the scheduled window', async () => {
    const before = await newExam({ tz: 'Asia/Kolkata', startsInMin: 30 })
    await rejects(start('alice', before), /outside its scheduled window/)
    const after = await newExam({ tz: 'America/New_York', startsInMin: -120, duration: 60 })
    await rejects(start('alice', after), /outside its scheduled window/)
    const during = await newExam({ tz: 'Asia/Kolkata', startsInMin: -10, duration: 60 })
    expect((await start('alice', during)).started_at).toBeTruthy()
  })

  it('rejects unknown time zones', async () => {
    await rejects(as('faculty', `update public.exams set time_zone = 'Mars/Olympus' where id = $1`, [fx.exam]), /unknown time zone/)
  })

  it('a student can have only one session per exam', async () => {
    const e = await newExam()
    await start('alice', e)
    await rejects(start('alice', e), /duplicate key|unique/)
  })
})

// ─────────────────────────────────────────────────────────────
describe('questions are served without answers', () => {
  it('students cannot read the questions table directly', async () => {
    const e = await newExam()
    expect((await as('alice', 'select * from public.questions where exam_id = $1', [e.exam])).rows).toEqual([])
  })

  it('get_exam_questions returns the paper without correct_answer, to assigned students only', async () => {
    const e = await newExam()
    const { rows } = await as('alice', 'select * from public.get_exam_questions($1)', [e.exam])
    expect(rows.map(r => r.question_type)).toEqual(['mcq', 'descriptive'])
    expect(Object.keys(rows[0])).not.toContain('correct_answer')
    expect((await as('carol', 'select * from public.get_exam_questions($1)', [e.exam])).rows).toEqual([])
  })

  it('for a scheduled exam, the paper is released only when the window opens', async () => {
    const e = await newExam({ tz: 'UTC', startsInMin: 30 })
    expect((await as('alice', 'select * from public.get_exam_questions($1)', [e.exam])).rows).toEqual([])
  })

  it('faculty still read and edit their own questions, including the answer key', async () => {
    const e = await newExam()
    const { rows } = await as('faculty', 'select correct_answer from public.questions where id = $1', [e.mcq])
    expect(rows[0].correct_answer).toBe('1')
  })
})

// ─────────────────────────────────────────────────────────────
describe('answer saving and submission', () => {
  it('saves and updates answers (upsert, as the autosave does)', async () => {
    const e = await newExam()
    const s = await start('alice', e)
    await saveAnswer('alice', s.id, e.mcq, '0')
    await saveAnswer('alice', s.id, e.mcq, '1')
    await saveAnswer('alice', s.id, e.essay, 'Objects resist changes in motion.')
    const { rows } = await as('alice', 'select question_id, answer_text from public.exam_answers where session_id = $1 order by answered_at', [s.id])
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.question_id === e.mcq).answer_text).toBe('1')
  })

  it('students cannot award themselves marks', async () => {
    const e = await newExam()
    const s = await start('alice', e)
    await saveAnswer('alice', s.id, e.essay, 'anything', 'true, 999')
    const a = await one(q('select is_correct, marks_awarded from public.exam_answers where session_id = $1', [s.id]))
    expect(a).toEqual({ is_correct: null, marks_awarded: null })
  })

  it('rejects answers to a question from a different exam', async () => {
    const e = await newExam(), other = await newExam()
    const s = await start('alice', e)
    await rejects(saveAnswer('alice', s.id, other.mcq, '1'), /not part of this exam/)
  })

  it("cannot write into another student's session", async () => {
    const e = await newExam()
    const s = await start('bob', e)
    await rejects(saveAnswer('alice', s.id, e.mcq, '1'), /not your exam session|row-level security/)
  })

  it('submitting stamps the server time and grades MCQs automatically', async () => {
    const e = await newExam()
    const s = await start('alice', e)
    await saveAnswer('alice', s.id, e.mcq, '1')
    await saveAnswer('alice', s.id, e.essay, 'text')
    await submit('alice', s.id)
    const sess = await one(q('select status, submitted_at from public.exam_sessions where id = $1', [s.id]))
    expect(sess.status).toBe('submitted')
    expect(Date.now() - new Date(sess.submitted_at).getTime()).toBeLessThan(60_000)   // not the client's 2000-01-01
    const r = await one(q('select marks_obtained, total_marks, grading_status from public.exam_results where session_id = $1', [s.id]))
    expect(r).toEqual({ marks_obtained: 2, total_marks: 7, grading_status: 'auto_graded' })
    // The client still calls the RPC afterwards; that is harmless.
    await as('alice', 'select public.auto_grade_session($1)', [s.id])
  })

  it('after submission answers and the session are locked, and cannot be deleted', async () => {
    const e = await newExam()
    const s = await start('alice', e)
    await saveAnswer('alice', s.id, e.mcq, '0')
    await submit('alice', s.id)
    await rejects(saveAnswer('alice', s.id, e.mcq, '1'), /closed/)
    await rejects(as('alice', `update public.exam_sessions set status = 'in_progress' where id = $1`, [s.id]), /closed/)
    await as('alice', 'delete from public.exam_sessions where id = $1', [s.id])
    await as('alice', 'delete from public.exam_answers where session_id = $1', [s.id])
    expect((await q('select count(*)::int as n from public.exam_answers where session_id = $1', [s.id])).rows[0].n).toBe(1)
    expect((await q('select count(*)::int as n from public.exam_sessions where id = $1', [s.id])).rows[0].n).toBe(1)
  })

  it('students cannot flag their own session or change its exam', async () => {
    const e = await newExam()
    const s = await start('alice', e)
    await rejects(submit('alice', s.id, 'flagged'), /only submit/)
    await rejects(as('alice', 'update public.exam_sessions set exam_id = $2 where id = $1', [s.id, fx.exam]), /cannot be changed/)
  })

  it('answers are refused once time is up (after the grace period)', async () => {
    const e = await newExam({ duration: 30 })
    const s = await start('alice', e)
    await q(`update public.exam_sessions set started_at = now() - interval '31 minutes' where id = $1`, [s.id])
    await saveAnswer('alice', s.id, e.mcq, '1')                                  // within 2-minute grace
    await q(`update public.exam_sessions set started_at = now() - interval '33 minutes' where id = $1`, [s.id])
    await rejects(saveAnswer('alice', s.id, e.mcq, '0'), /Time is up/)
  })

  it('a timed-out client can still close its session (timer expiry)', async () => {
    const e = await newExam({ duration: 30 })
    const s = await start('alice', e)
    await q(`update public.exam_sessions set started_at = now() - interval '40 minutes' where id = $1`, [s.id])
    await submit('alice', s.id, 'timed_out')
    expect((await one(q('select status from public.exam_sessions where id = $1', [s.id]))).status).toBe('timed_out')
  })

  it('finalize_expired_sessions auto-submits abandoned sessions at their deadline and grades them', async () => {
    const e = await newExam({ duration: 30 })
    const abandoned = await start('alice', e)
    const active = await start('bob', e)
    await saveAnswer('alice', abandoned.id, e.mcq, '1')
    await q(`update public.exam_sessions set started_at = now() - interval '45 minutes' where id = $1`, [abandoned.id])

    await rejects(as('other', 'select public.finalize_expired_sessions($1)', [e.exam]), /not allowed/)
    await rejects(as('alice', 'select public.finalize_expired_sessions($1)', [e.exam]), /not allowed/)
    await rejects(as('faculty', 'select public.finalize_expired_sessions()'), /not allowed/)

    expect((await one(as('faculty', 'select public.finalize_expired_sessions($1) as n', [e.exam]))).n).toBe(1)
    const s = await one(q(`select status, extract(epoch from submitted_at - started_at)::int / 60 as took from public.exam_sessions where id = $1`, [abandoned.id]))
    expect(s.status).toBe('timed_out')
    expect(s.took).toBe(30)
    expect((await one(q('select marks_obtained from public.exam_results where session_id = $1', [abandoned.id]))).marks_obtained).toBe(2)
    expect((await one(q('select status from public.exam_sessions where id = $1', [active.id]))).status).toBe('in_progress')
  })
})

// ─────────────────────────────────────────────────────────────
describe('grading functions', () => {
  async function submittedEssay() {
    const e = await newExam()
    const s = await start('alice', e)
    await saveAnswer('alice', s.id, e.essay, 'essay')
    const answer = (await one(q('select id from public.exam_answers where session_id = $1', [s.id]))).id
    return { e, s, answer }
  }

  it('only the exam owner can award descriptive marks, within the question maximum', async () => {
    const { s, answer } = await submittedEssay()
    await rejects(as('faculty', 'select public.update_descriptive_marks($1, 4, $2)', [answer, ID.faculty]), /in progress/)
    await submit('alice', s.id)
    await rejects(as('alice', 'select public.update_descriptive_marks($1, 5, $2)', [answer, ID.alice]), /not allowed/)
    await rejects(as('other', 'select public.update_descriptive_marks($1, 5, $2)', [answer, ID.other]), /not allowed/)
    await rejects(as('faculty', 'select public.update_descriptive_marks($1, 6, $2)', [answer, ID.faculty]), /between 0 and 5/)

    await as('faculty', 'select public.update_descriptive_marks($1, 4, $2)', [answer, ID.other])   // grader id is ignored
    const r = await one(q('select marks_obtained, graded_by from public.exam_results where session_id = $1', [s.id]))
    expect(r).toEqual({ marks_obtained: 4, graded_by: ID.faculty })
  })

  it("auto_grade_session refuses open sessions and other people's sessions", async () => {
    const { s } = await submittedEssay()
    await rejects(as('alice', 'select public.auto_grade_session($1)', [s.id]), /in progress/)
    await submit('alice', s.id)
    await rejects(as('bob', 'select public.auto_grade_session($1)', [s.id]), /not allowed/)
  })
})

// ─────────────────────────────────────────────────────────────
describe('monitoring alerts and evidence capture (end to end)', () => {
  it('a live session logs alerts and evidence that only its faculty can read, then locks on submit', async () => {
    const e = await newExam()
    const s = await start('alice', e)
    const ps = (await one(as('alice', 'insert into public.proctoring_sessions (exam_session_id) values ($1) returning id', [s.id]))).id
    const eventId = '00000000-0000-0000-0000-00000000e601'
    await as('alice', `insert into public.proctoring_events (id, proctoring_session_id, event_type, severity, confidence, metadata)
                       values ($1, $2, 'phone_detected', 'high', 0.81, '{"class_name":"cell phone"}')`, [eventId, ps])
    await as('alice', `insert into storage.objects (bucket_id, name) values ('proctoring-frames', $1)`, [`${s.id}/${eventId}.jpg`])
    await rejects(as('alice', `insert into storage.objects (bucket_id, name) values ('proctoring-frames', $1)`,
      [`${fx.bob.examSession}/${eventId}.jpg`]), RLS)

    const ev = await one(as('faculty', 'select event_type, confidence, student_id, exam_id from public.proctoring_events where id = $1', [eventId]))
    expect(ev).toMatchObject({ event_type: 'phone_detected', student_id: fx.alice.student, exam_id: e.exam })
    expect((await as('faculty', `select name from storage.objects where name = $1`, [`${s.id}/${eventId}.jpg`])).rows).toHaveLength(1)
    expect((await as('other', `select name from storage.objects where name = $1`, [`${s.id}/${eventId}.jpg`])).rows).toHaveLength(0)
    expect((await as('alice', `select name from storage.objects where name = $1`, [`${s.id}/${eventId}.jpg`])).rows).toHaveLength(0)

    const score = await one(as('faculty', 'select score, total_events from public.risk_scores where exam_session_id = $1', [s.id]))
    expect(score.total_events).toBe(1)
    expect(Number(score.score)).toBeGreaterThan(0)

    await submit('alice', s.id)
    await rejects(as('alice', `insert into public.proctoring_events (proctoring_session_id, event_type) values ($1, 'tab_switch')`, [ps]), RLS)
  })
})

// ─────────────────────────────────────────────────────────────
describe('database security: unauthorized access prevention', () => {
  it('every table in public has row-level security enabled', async () => {
    const { rows } = await q(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)
    expect(rows.map(r => r.relname)).toEqual([])
  })

  it('only reviewed security-definer functions are callable by signed-in users', async () => {
    // Each entry was checked to enforce its own authorisation (or to reveal
    // only a yes/no about the caller themself).
    const ALLOWED = [
      'answer_context', 'assignment_matches', 'auto_grade_session', 'close_proctoring_event', 'finalize_expired_sessions', 'get_exam_questions',
      'get_risk_config', 'is_assigned_to_exam', 'is_event_owner', 'is_exam_owner', 'is_own_active_exam_session',
      'is_own_assignment', 'is_own_closed_session', 'owns_exam', 'owns_trial', 'profile_role', 'refresh_exam_metrics',
      'report_live_status', 'risk_evaluation_data', 'update_descriptive_marks', 'exam_window',
    ].sort()
    const { rows } = await q(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
        and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1`)
    expect(rows.map(r => r.proname)).toEqual(ALLOWED)
  })

  it('anonymous users cannot call any security-definer function', async () => {
    const { rows } = await q(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
        and has_function_privilege('anon', p.oid, 'EXECUTE')`)
    expect(rows).toEqual([])
  })

  it('internal functions are not callable from the API', async () => {
    for (const call of [
      `select public.log_audit_event('${ID.faculty}', 'faculty', 'x')`,
      `select public.refresh_system_metrics('${fx.exam}')`,
      `select public.grade_session('${fx.alice.examSession}')`,
      `select public.compute_risk_breakdown_ex('${fx.alice.examSession}', now(), true)`,
    ]) await rejects(as('alice', call), /permission denied/)
  })

  it('audit entries are stamped with the real caller and cannot be edited', async () => {
    await as('alice', `insert into public.audit_log (actor_id, actor_role, action) values ($1, 'faculty', 'export.csv')`, [ID.faculty])
    const row = await one(q(`select actor_id, actor_role from public.audit_log where action = 'export.csv'`))
    expect(row).toEqual({ actor_id: ID.alice, actor_role: 'student' })
    await as('alice', `update public.audit_log set action = 'nothing' where action = 'export.csv'`)
    await as('alice', `delete from public.audit_log where action = 'export.csv'`)
    expect((await q(`select count(*)::int as n from public.audit_log where action = 'export.csv'`)).rows[0].n).toBe(1)
  })

  it('system metrics are read-only for clients and refreshable only by the exam owner', async () => {
    await rejects(as('alice', `insert into public.system_metrics (exam_id) values ($1)`, [fx.exam]), RLS)
    await rejects(as('other', 'select public.refresh_exam_metrics($1)', [fx.exam]), /not allowed/)
    await as('faculty', 'select public.refresh_exam_metrics($1)', [fx.exam])
    expect((await as('faculty', 'select total_sessions from public.system_metrics where exam_id = $1', [fx.exam])).rows[0].total_sessions).toBeGreaterThan(0)
    expect((await as('other', 'select * from public.system_metrics where exam_id = $1', [fx.exam])).rows).toEqual([])
  })

  it("feedback can only be left on the student's own closed session", async () => {
    const e = await newExam()
    const s = await start('alice', e)
    const fb = who => as(who, 'insert into public.feedback (session_id, student_id, exam_id, rating) values ($1, $2, $3, 4)',
      [s.id, fx.alice.student, e.exam])
    await rejects(fb('alice'), RLS)            // still in progress
    await submit('alice', s.id)
    await rejects(fb('bob'), RLS)
    await fb('alice')
  })
})
