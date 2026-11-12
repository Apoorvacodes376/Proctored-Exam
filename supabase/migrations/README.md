# ProctorAI — Supabase Migrations

## Directory layout

```
supabase/
├── schema.sql                        ← original schema (kept as backup, do not run)
└── migrations/
    ├── phase1_setup.sql              ← auth foundation
    ├── phase2_faculty_management.sql ← student/exam/question management
    ├── phase2_patch_rls_recursion.sql← fix: exams ↔ exam_assignments RLS recursion
    ├── phase3_student_exam.sql       ← exam-taking, answers, results
    ├── phase4_ai_monitoring.sql      ← proctoring sessions, events, snapshots
    ├── phase4_patch_monitoring.sql   ← browser monitors: event fields/types, RLS, evidence
    ├── phase5_review_risk_scoring.sql← risk scores, faculty review workflow
    ├── phase5_patch_monitoring_review.sql ← live status, transparent scoring, review decisions, realtime
    ├── phase6_research_evaluation.sql← audit log, metrics, feedback
    ├── phase6_patch_integrity_evaluation.sql ← exam-integrity/security fixes, research evaluation tables
    └── README.md                     ← this file
```

`schema.sql` is preserved as a read-only backup of the original Phase 1 + 2
schema. **Do not run it.** The six phase files are the authoritative source of
truth going forward.

---

## Execution order

Run the files **in phase order** in the Supabase SQL Editor
(**Dashboard → SQL Editor → New query → paste → Run**).

| Order | File | Tables / objects created |
|-------|------|--------------------------|
| 1 | `phase1_setup.sql` | `profiles`, `handle_new_user()`, `set_updated_at()`, profiles RLS |
| 2 | `phase2_faculty_management.sql` | `students`, `exams`, `questions`, `exam_assignments`, storage bucket `student-photos`, all Phase 2 RLS |
| 2a | `phase2_patch_rls_recursion.sql` | Replaces two policies that made **every** non-superuser query on `exams` / `exam_assignments` / `exam_sessions` fail with *infinite recursion detected in policy*. Same access rules, via `is_exam_owner()` / `is_assigned_to_exam()` |
| 3 | `phase3_student_exam.sql` | `exam_sessions`, `exam_answers`, `exam_results`, `auto_grade_session()`, Phase 3 RLS |
| 4 | `phase4_ai_monitoring.sql` | `proctoring_sessions`, `proctoring_events`, `proctoring_snapshots`, storage bucket `proctoring-frames`, Phase 4 RLS |
| 4a | `phase4_patch_monitoring.sql` | `proctoring_events.student_id/exam_id/ended_at/duration_ms`, new event types, `close_proctoring_event()`, `is_own_active_exam_session()`, students-only-own-session RLS, evidence storage policies |
| 5 | `phase5_review_risk_scoring.sql` | `risk_scores`, `faculty_reviews`, `update_risk_score()`, `update_descriptive_marks()`, Phase 5 RLS |
| 5a | `phase5_patch_monitoring_review.sql` | `exam_risk_settings`, `identity_verifications`, `session_reviews` (+ append-only `session_review_history`), live-status heartbeat columns + `report_live_status()`, rewritten `update_risk_score()` / new `compute_risk_breakdown()` with stored breakdown, recompute triggers, RLS fixes for `risk_scores` and `faculty_reviews`, Realtime publication |
| 6 | `phase6_research_evaluation.sql` | `audit_log`, `system_metrics`, `feedback`, `log_audit_event()`, `refresh_system_metrics()`, Phase 6 RLS |
| 6a | `phase6_patch_integrity_evaluation.sql` | `exams.time_zone` + server-enforced exam window; guarded student writes to `exam_sessions` / `exam_answers`; grading on close, `finalize_expired_sessions()`; owner-only `update_descriptive_marks()` / `auto_grade_session()`; `get_exam_questions()` (no answer key for students); fixes to audit log, system metrics and feedback RLS; research tables `evaluation_trials`, `ground_truth_intervals`, `identity_ground_truth`, `monitoring_performance`, `model_evaluations`; `compute_risk_breakdown_ex()` / `risk_evaluation_data()`; no anonymous EXECUTE on security-definer functions |

**Never skip a phase.** Each phase references tables created by the previous
one. Running them out of order will produce foreign-key or function-not-found
errors.

---

## Dependency graph

```
phase1_setup
    └── phase2_faculty_management
            └── phase3_student_exam
                    └── phase4_ai_monitoring
                            └── phase5_review_risk_scoring
                                        └── phase6_research_evaluation
```

---

## Re-run safety

Phases 1 and 2 have already been partially applied to the live database.
All six files are written to be **fully idempotent** — safe to re-run against
a database that already has some or all of the objects.

| Technique | Applied to |
|-----------|-----------|
| `CREATE TABLE IF NOT EXISTS` | all phases |
| `CREATE INDEX IF NOT EXISTS` | all phases |
| `DO $$ … IF NOT EXISTS … ADD CONSTRAINT $$` | phases 2, 3 |
| `DO $$ … IF NOT EXISTS … ADD COLUMN $$` | phases 3, 4 (FK back-fill) |
| `CREATE OR REPLACE FUNCTION` | phases 1, 3, 5, 6 |
| `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` | phases 1, 2, 3, 4, 5 |
| `DROP POLICY IF EXISTS` + `CREATE POLICY` | all phases |
| `ALTER TABLE … ENABLE ROW LEVEL SECURITY` (idempotent) | all phases |
| `INSERT … ON CONFLICT DO NOTHING` | phases 2, 4 (storage buckets) |

**Nothing is ever dropped, truncated, or reset.** Existing data is preserved
in every case.

---

## What was fixed vs. `schema.sql`

### Recursive RLS on `profiles` (critical — would crash at runtime)
The original "Faculty can view student profiles" and "Users can update own
profile" policies both queried `public.profiles` from inside a `profiles`
policy. PostgreSQL evaluates RLS recursively, causing a
`stack depth limit exceeded` error on any faculty profile read.

**Fix (phase1):** Both policies now read the role from `auth.jwt() ->> 'role'`
(the JWT claim Supabase embeds at login) — no table lookup, no recursion.

### Role escalation via signup metadata
`handle_new_user` trusted `raw_user_meta_data->>'role'`, so any client calling
`supabase.auth.signUp({ data: { role: 'faculty' } })` received a faculty
account.

**Fix (phase1):** Role is hardcoded to `'student'` in the trigger. Faculty
promotion is a manual privileged operation (see below).

### `auth.role()` deprecated in storage policies
`auth.role() = 'authenticated'` returns `null` in Supabase Auth v2+.

**Fix (phase2):** Replaced with `auth.uid() is not null`.

### Overly broad storage policies
Any authenticated user could read, write, or delete any file in
`student-photos`.

**Fix (phase2):** Faculty can only access files under their own
`<faculty_uid>/` folder. Students can only read the single file whose name
matches their own student UUID.

### Per-row `profiles` subselect in RLS (performance)
`(select email from public.profiles where id = auth.uid())` ran as a
correlated subquery on every row evaluated by RLS on `students`, `exams`,
`questions`, and `exam_assignments`.

**Fix (phases 2–6):** Replaced with `auth.email()` — reads from the JWT
directly, zero database round-trips.

### Non-idempotent `updated_at` triggers
`CREATE TRIGGER students_updated_at` (no guard) would error on re-run.

**Fix (phase2):** Every trigger is preceded by `DROP TRIGGER IF EXISTS`.

---

## Manual operations

These require a human decision and cannot be automated safely.

### Promoting a user to faculty

Because role escalation is blocked at signup, faculty accounts must be
promoted via a privileged path.

**Option A — Supabase Dashboard**
1. Go to **Table Editor → profiles**.
2. Find the user's row and set `role = 'faculty'`.

**Option B — SQL (service-role only, never from the client)**
```sql
update public.profiles
set    role = 'faculty'
where  email = 'faculty@university.edu';
```

> After promotion the user must sign out and back in. The JWT carries the role
> claim that was embedded at login time; `auth.jwt() ->> 'role'` will not
> reflect the change until a new token is issued.

### Storage bucket visibility

Both buckets (`student-photos`, `proctoring-frames`) are created as **private**
(`public = false`). Photo URLs stored in `students.photo_url` must be
**signed URLs** generated server-side, or the bucket must be made public.

To make `student-photos` public:
```sql
update storage.buckets set public = true where id = 'student-photos';
```
Then remove the `SELECT` policies for that bucket (they become redundant) and
regenerate stored `photo_url` values to use the public URL format.

### Tightening backend storage policies (phase4)

`phase4_patch_monitoring.sql` replaces the `"Backend upload proctoring frames"`,
`"Backend manage proctoring sessions"`, `"Backend insert proctoring events"` and
`"Backend insert proctoring snapshots"` policies, which allowed **any**
authenticated user. Students can now only create/append to their own
in-progress session, and cannot read events or evidence. A backend AI worker
should use the service-role key, which bypasses RLS.

### Phase 5 security fixes

`phase5_patch_monitoring_review.sql` removes `"Backend manage risk scores"`,
which let any authenticated user write any risk score. Scores are now written
only by security-definer functions/triggers (or the service role). It also
replaces `"Faculty manage own reviews"`, which let faculty annotate events from
other faculty members' exams, with an exam-ownership check.

### Phase 6 fixes

`phase6_patch_integrity_evaluation.sql` closes holes found while writing the
Phase 6 end-to-end tests (`frontend/tests/db/phase6_security.test.js`):

| Problem | Fix |
|---|---|
| Students could write `is_correct` / `marks_awarded` on their own answers, and `auto_grade_session()` summed them | Student writes to `exam_answers` have the grading fields cleared by trigger |
| Answers could be changed after submission or after time ran out | Refused unless the session is in progress and within `duration + submission_grace()` (2 min) |
| Students could DELETE their exam session (cascading to all proctoring events/evidence), reopen it, backdate `started_at`, or set `status = 'flagged'` | `for all` policy split into select/insert/update; trigger guards the allowed transitions and stamps server times |
| Sessions could be started without a matching assignment, or at any time | Insert requires the student's own assignment; for exams with `time_zone` set, only inside the scheduled window |
| Students could read `questions.correct_answer` | Student SELECT on `questions` removed; students use `get_exam_questions()` |
| Any signed-in user could call `update_descriptive_marks()` on any answer | Exam owner only, closed sessions, `0..question.marks` |
| `audit_log` rows could be inserted with any `actor_id` | Actor and time stamped by trigger; `log_audit_event()` internal only |
| `system_metrics` writable by any user ("Backend manage system metrics") | Policy removed; owner-only `refresh_exam_metrics()` wrapper |
| Feedback could be attached to another student's session | Only for the student's own closed session |
| "Users can update own profile" compared with the JWT `role` claim (`authenticated` in Supabase), so it never matched | Compares with the stored role via `profile_role()` |
| Supabase grants `anon` EXECUTE on new functions | Revoked for every security-definer function in `public` |

It also adds one line to `phase6_research_evaluation.sql`: a missing
`drop policy if exists "Students view own feedback"`. Without it, re-running
that file failed.

**Client changes that go with it:** `ExamRoom` loads questions through
`get_exam_questions()`, and `ExamForm` records the faculty member's time
zone. Apply the patch before deploying that frontend; the old student
question query returns no rows once the patch is in.

### Re-running phase 2

`phase2_faculty_management.sql` recreates the recursive policies. If you ever
re-run it, run `phase2_patch_rls_recursion.sql` again afterwards.

### Testing migrations locally

`cd frontend && npm test` applies every migration file to an in-process
Postgres (PGlite) with stand-ins for Supabase's `auth`/`storage` schemas and
default grants, and checks the RLS rules of every phase by acting as
different users — see `frontend/tests/db/`.

---

## Adding future migrations

1. Create `supabase/migrations/phase7_description.sql` (or a patch file such
   as `phase2_patch_add_column.sql` if amending an existing phase).
2. Use the same idempotency patterns throughout.
3. Never modify an already-executed phase file — always add a new file.
4. Add a row to the execution-order table above.
5. Document any new manual operations in this README.
