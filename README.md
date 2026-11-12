# ProctorAI — AI-Based Online Exam Proctoring System

A browser-based exam platform with automated proctoring alerts, faculty
review, transparent risk scoring and a research evaluation module.

**The system produces evidence for human review, not verdicts.** No alert,
risk score or model output changes a student's status, marks or eligibility;
faculty make every decision.

## Contents

1. [Features](#features)
2. [Project structure](#project-structure)
3. [Installation](#installation)
4. [Environment configuration](#environment-configuration)
5. [Supabase setup](#supabase-setup)
6. [Google OAuth configuration](#google-oauth-configuration)
7. [ML model setup](#ml-model-setup)
8. [Starting the frontend and backend](#starting-the-frontend-and-backend)
9. [Testing](#testing)
10. [Phase 4 — AI monitoring](#phase-4--ai-monitoring)
11. [Phase 5 — Live monitoring, risk scoring and review](#phase-5--live-monitoring-risk-scoring-and-review)
12. [Phase 6 — Research evaluation](#phase-6--research-evaluation)
13. [Research integrity](#research-integrity)
14. [Known limitations](#known-limitations)
15. [Security notes](#security-notes)

---

## Features

| Phase | What it adds |
|---|---|
| 1 | Sign-up/sign-in (email + password, Google OAuth), student and faculty dashboards, light/dark theme |
| 2 | Faculty manage students (with reference photos), exams, questions (MCQ + descriptive) and assignments |
| 3 | Students take scheduled exams: identity check against the reference photo, autosave, countdown, automatic submission, MCQ auto-grading |
| 4 | In-browser monitoring: face presence, multiple people, phones/books (YOLOv8n), speech/noise, camera/mic status, tab/focus changes, evidence snapshots |
| 5 | Live faculty monitor over WebSockets, transparent configurable risk score, review dashboard with evidence and recorded decisions, optional offline learned model |
| 6 | Evaluation module (precision/recall, FAR/FRR, F1, ROC-AUC, false alerts per hour, latency) computed only from labelled ground truth, charts, CSV export, end-to-end tests, security fixes |

---

## Project structure

```
Proctored-Exam/
├── frontend/                 React 19 + Vite + Tailwind CSS 4
│   ├── src/monitoring/       Phase 4 detectors (independent, unit-tested)
│   ├── src/review/           Phase 5 live-monitor / review logic
│   ├── src/evaluation/       Phase 6 metrics, ground-truth matching, report, CSV
│   ├── src/identity/         face-match decision rule
│   ├── src/pages/faculty/    Monitor, Review, Evaluation, Annotate pages
│   └── tests/db/             migration + RLS tests (in-process Postgres)
├── backend/                  FastAPI (JWT-protected API) + ml/ (optional, offline)
├── supabase/
│   ├── migrations/           authoritative schema — run in order (see its README)
│   └── schema.sql            original schema, kept for reference only — do not run
└── README.md
```

---

## Installation

Prerequisites: **Node.js 20+** (22 tested), **Python 3.11+** (3.12 tested),
a [Supabase](https://supabase.com) project, and a webcam/microphone for
taking exams.

```bash
git clone <your-repo-url> Proctored-Exam
cd Proctored-Exam

# Frontend
cd frontend
npm install
cp .env.example .env          # then edit, see below

# Backend
cd ../backend
python -m venv venv
venv\Scripts\activate         # Windows
# source venv/bin/activate    # macOS/Linux
pip install -r requirements.txt
cp .env.example .env          # then edit, see below

# Optional: the offline risk-model tools
pip install -r requirements-ml.txt
```

---

## Environment configuration

### `frontend/.env`

| Variable | Required | Meaning |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Project URL (**Project Settings → API**) |
| `VITE_SUPABASE_ANON_KEY` | yes | `anon` / public key |
| `VITE_YOLO_MODEL_URL` | no | Where the browser loads YOLOv8n from (default: a pinned Hugging Face copy). Self-hosting is recommended, e.g. `/models/yolov8n.onnx` in `frontend/public/` |
| `VITE_FACE_GRACE_MS` | no | Continuous face absence (ms) before an alert. Default `8000` |

### `backend/.env`

| Variable | Meaning |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key — bypasses RLS. **Backend only, never in the frontend or in git** |
| `SUPABASE_JWT_SECRET` | **Project Settings → API → JWT Settings** (used to verify user tokens) |

Both `.env` files are git-ignored; only the `.env.example` files are committed.

---

## Supabase setup

1. **Create a project** at [supabase.com](https://supabase.com).
2. **Run the migrations in order** in **SQL Editor → New query** (paste each
   file, run it). The full table with what each file does is in
   [`supabase/migrations/README.md`](supabase/migrations/README.md):

   ```
   phase1_setup.sql
   phase2_faculty_management.sql
   phase2_patch_rls_recursion.sql
   phase3_student_exam.sql
   phase4_ai_monitoring.sql
   phase4_patch_monitoring.sql
   phase5_review_risk_scoring.sql
   phase5_patch_monitoring_review.sql
   phase6_research_evaluation.sql
   phase6_patch_integrity_evaluation.sql
   ```

   Every file is idempotent. Do **not** run `supabase/schema.sql`. The
   migrations create the private storage buckets `student-photos` and
   `proctoring-frames` with their access policies.
3. **Auth URLs** — **Authentication → URL Configuration**:
   - Site URL: `http://localhost:5173` (your production URL later)
   - Redirect URLs: `http://localhost:5173/auth/callback`
4. **Realtime** — the Phase 5 patch adds the monitored tables to the
   `supabase_realtime` publication. If your project was created without
   Realtime, enable it under **Database → Replication**.
5. **Faculty accounts** — every sign-up becomes a *student* (the client
   cannot choose its role). Promote faculty in **Table Editor → profiles**
   (`role = 'faculty'`) or with SQL as the service role:
   ```sql
   update public.profiles set role = 'faculty' where email = 'teacher@university.edu';
   ```
   The user must sign out and in again.
6. **Optional: automatic submission without an open faculty page.** Sessions
   whose browser never comes back (closed laptop, crash) are closed as
   *timed out* at their deadline by `finalize_expired_sessions()`. The faculty
   Monitor/Review pages call it every minute for the exam they show. To do it
   server-side regardless, enable the `pg_cron` extension
   (**Database → Extensions**) and run:
   ```sql
   select cron.schedule('finalize-exams', '* * * * *', $$ select public.finalize_expired_sessions() $$);
   ```

---

## Google OAuth configuration

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or
   select a project, then **APIs & Services → OAuth consent screen**: choose
   *External* (or *Internal* for a Workspace domain), add the app name and
   support email, and the scopes `openid`, `email` and `profile`.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**:
   - Authorized JavaScript origins: `http://localhost:5173` (and your production origin)
   - Authorized redirect URIs: `https://<your-project-id>.supabase.co/auth/v1/callback`
3. Copy the **Client ID** and **Client secret** into Supabase:
   **Authentication → Providers → Google → Enable**.
4. Make sure `http://localhost:5173/auth/callback` is in Supabase's redirect URLs
   (step 3 of the Supabase setup). The app sends users there after Google sign-in.

New Google users get the *student* role like everyone else; promote faculty
as described above.

---

## ML model setup

No model is trained or shipped by this repository, and no accuracy is
claimed for any model.

| Model | Used for | Where it comes from |
|---|---|---|
| face-api.js SSD MobileNet v1 + 68-point landmarks + face recognition | identity check (embedding distance), face presence/count | Loaded by the browser from `cdn.jsdelivr.net/npm/@vladmandic/face-api/model` |
| YOLOv8n (COCO, ONNX) | phones, books, person count | Pinned Hugging Face copy (`webml/yolov8n`) or `VITE_YOLO_MODEL_URL`. Weights © Ultralytics, **AGPL-3.0** — check the licence suits your deployment |
| ONNX Runtime Web 1.18 | runs YOLO in the browser | jsDelivr CDN |
| Optional learned risk model | offline research comparison only | Trained by you from faculty-labelled sessions (below) |

**Self-hosting the YOLO model** (recommended for exams: faster and no
third-party request during the exam): run `npm run test:assets` in
`frontend/`, copy `.cache/test-assets/yolov8n.onnx` to `frontend/public/models/`,
and set `VITE_YOLO_MODEL_URL=/models/yolov8n.onnx`.

**Identity-match thresholds** (`frontend/src/identity/matching.js`):
distance ≤ 0.52 passes, ≤ 0.70 goes to manual review, above that fails. These
are uncalibrated defaults. Measure FAR/FRR for your setting on the
Evaluation page before relying on them.

**Optional learned risk model.** This is offline and experimental, and it is
never used for live scoring:

```bash
cd backend
pip install -r requirements-ml.txt
python -m ml.train_risk_model --from-supabase [--exam <exam-id>] [--model logistic|gradient_boosting|xgboost]
```

The script refuses to train with fewer than 40 labelled sessions or fewer
than 10 of either outcome. It uses scores recomputed *without* faculty
dismissals (`risk_evaluation_data()`), so reviewers' own decisions don't
leak into the features. It reports stratified cross-validation results next
to the rule-based score on the same labels. It writes
`models/risk_model_<time>.joblib` and a `.card.json`. Import the card on the
Evaluation page to compare it with the rule-based score.

---

## Starting the frontend and backend

```bash
# Frontend — http://localhost:5173
cd frontend
npm run dev          # development
npm run build        # production build into dist/
npm run preview      # serve the production build

# Backend — http://localhost:8000 (API docs at /docs)
cd backend
venv\Scripts\activate
uvicorn app.main:app --reload
```

The frontend talks to Supabase directly; the FastAPI backend provides
JWT-protected API routes (`/api/me`, role-checked dashboard routes) and the
offline ML tools. Vite proxies `/api` to `localhost:8000` in development.

---

## Testing

```bash
cd frontend
npm test                  # everything below (≈290 tests)
npm run test:assets       # once: downloads YOLOv8n + sample photos so the
                          # real-model tests run instead of being skipped
npm run lint

cd ../backend
venv\Scripts\activate
python -m unittest discover tests                 # API auth / role checks
python -m unittest ml.test_train_risk_model       # needs requirements-ml.txt
```

| Area | Tests |
|---|---|
| Authentication & roles | `tests/db/phase6_security.test.js` (sign-up is always *student*, no self-promotion, own-profile only, anonymous users see nothing), `src/components/__tests__/ProtectedRoute.test.jsx`, `backend/tests/test_auth.py` (invalid/expired tokens, role from `profiles` not client metadata) |
| Assignment & scheduling | `phase6_security.test.js`: assign only own students to own exams, students see only assigned exams, no session without an assignment, server time zone window, server-set start time, one session per exam |
| Identity verification | decision rule + FAR/FRR (`src/evaluation/__tests__/metrics.test.js`), attempt logging and identity flag (`phase5_workflow.test.js`), identity ground-truth access (`phase6_evaluation.test.js`) |
| Answer saving & automatic submission | `phase6_security.test.js` (upsert, grading fields stripped, wrong-exam questions refused, locked after submit / after the deadline + grace, auto-grading on submit, `finalize_expired_sessions`), `src/components/__tests__/ExamTimer.test.jsx` (countdown and one-time expiry) |
| Monitoring alerts & evidence | `src/monitoring/__tests__/*` (each detector), `phase4_patch.test.js`, end-to-end alert → evidence → score → lock in `phase6_security.test.js`, evidence retrieval in `phase5_workflow.test.js` |
| Risk score | `phase5_scoring.test.js` (exact arithmetic), `phase5_workflow.test.js` (triggers), review-independent score in `phase6_evaluation.test.js` |
| Real-time updates | `src/review/__tests__/realtime.websocket.test.js` (real supabase-js over a WebSocket to a local Realtime-protocol server) |
| Database security | `phase6_security.test.js`: every table has RLS; only an allow-list of security-definer functions is callable by signed-in users and none by anonymous users; internal functions refused; audit entries stamped and append-only; grading functions owner-only |
| Evaluation | `src/evaluation/__tests__/*` (metrics against hand-computed values, interval matching, report, CSV), page render test |

The database tests apply the **real migration files** to an in-process
Postgres (PGlite), with small stand-ins for Supabase's `auth` and `storage`
schemas and Supabase's default grants, then act as different users.

**Not covered:** the hosted Supabase services themselves: PostgREST query
syntax/embeds used by the pages, Realtime's RLS filtering, Storage signed
URLs, and the Google OAuth round trip. Also not covered: interactive
clicking through the pages in a browser. Running the app against a local
Supabase stack (`supabase start`, needs Docker) or a staging project covers
these.

---

## Phase 4 — AI monitoring

During an exam the browser runs these modules (`frontend/src/monitoring/`), each
independent of React/Supabase and unit-tested on its own:

| Module | File | Detects | Event type(s) |
|---|---|---|---|
| Face presence | `faceMonitor.js` | No face for longer than a grace period (`VITE_FACE_GRACE_MS`, default 8 s) | `face_not_detected` |
| Multiple people | `faceMonitor.js` + `objectMonitor.js` | >1 face (face-api) or >1 person (YOLO) in 2 of 3 scans | `multiple_faces` |
| Objects | `objectMonitor.js` | COCO *cell phone* / *book* via YOLOv8n (ONNX Runtime Web) | `phone_detected`, `object_detected` |
| Audio | `vad.js`, `audioMonitor.js` | Sustained speech vs. loud non-speech noise; steady background is absorbed | `speech_detected`, `unusual_noise` |
| Camera / mic | `streamMonitor.js` | Missing, ended, muted or permission-revoked tracks | `camera_interrupted`, `mic_interrupted` |
| Tab / focus | `tabMonitor.js` | Leaving the tab, or the window losing focus | `tab_switch`, `focus_lost` |
| Logging + evidence | `eventLogger.js`, `episodes.js` | Writes events and snapshots | — |
| Latency | `latency.js` | Per-frame / per-window processing time of the face, object and audio modules | (summaries in `monitoring_performance`) |

**One event per episode.** A continuous condition (face away, camera off, away from
the tab) is logged once when it starts; its end time and duration are recorded on
the same row (`ended_at`, `duration_ms`). Repeated detections are rate-limited per
type, and the cooldown is checked *before* a snapshot is taken.

**Each event records** student ID, exam ID, event type, timestamp, severity,
detection confidence (where the detector produces one), metadata, and a linked
snapshot when evidence was captured. Student and exam IDs are stamped server-side
from the exam session, not trusted from the client.

**Evidence** is a single webcam JPEG captured at alert points (face absent, multiple
people, prohibited object), stored privately at
`proctoring-frames/<exam_session_id>/<event_id>.jpg`. Students can upload into their
own in-progress session only and cannot read evidence back; only the exam's
faculty can view or delete it.

**Student experience.** Before the camera prompt the student sees what is
monitored and what isn't. During the exam a "Monitoring active" panel with a
webcam self-view and per-module status is always visible, alerts explain what was
recorded, and an interrupted camera/mic shows a **Reconnect** button.

---

## Phase 5 — Live monitoring, risk scoring and review

| Page | Route | What it shows |
|---|---|---|
| Live Monitor | `/faculty/monitor?exam=…` | Every student currently taking the exam: connection, camera, mic, face, multiple-person / object / audio / tab-switch / missing-face counts, total alerts, risk score, identity flag. Updates in real time. |
| Review | `/faculty/review?exam=…` | Sessions at or above the review threshold (or with an identity flag), main score contributors, decision status, per-exam scoring settings, and identity requests from students who never started. |
| Session review | `/faculty/review/:sessionId` | Score breakdown, identity attempts (separate), all events oldest-first with confidence, duration, scoring status and evidence snapshots; per-event review; the session decision with explanation and history. |

**Real time.** The pages subscribe to Supabase Realtime, which streams
Postgres changes over a WebSocket and only delivers a change to faculty whose
RLS lets them read that row. Students' browsers send a heartbeat with their
live status about every 10 s (`report_live_status`); "No signal" means nothing
has arrived for 30 s. On every (re)connect the page reloads everything, so
changes missed while offline aren't lost.

**Risk score** (computed in the database by `compute_risk_breakdown`, stored
with its full breakdown, recomputed whenever an event, review, verification
attempt or setting changes):

```
score (0–100) = Σ weight × min(1, effective / saturation) / Σ weight × 100
effective     = Σ counted events:   type factor × confidence × (1 + duration / seconds_per_unit)
              + Σ merged duplicates: type factor × confidence × (duration / seconds_per_unit)
```

- Repeats of the same alert within `dedupe_window_s` add their duration, not another count.
- Detections below `min_confidence` and events faculty dismissed are listed but not scored.
- Ongoing episodes grow until now or submission, capped at `max_episode_s`.
- **Identity verification is not part of the score.** It raises a separate *Identity* flag.
- Faculty set thresholds, weights and the other parameters per exam (Review → Scoring rules).

A score never changes a session's status, marks or eligibility. Faculty record
*cleared for evaluation* or *hold — further review* with a required
explanation, kept in an append-only history with the score at that time.

---

## Phase 6 — Research evaluation

The **Evaluation** page (`/faculty/evaluation`, one exam or all of a faculty
member's exams) computes every figure in `frontend/src/evaluation/` from rows
in the database. Each figure carries a provenance badge (see
[Research integrity](#research-integrity)).

### Metrics

| Metric | Computed from | Definition |
|---|---|---|
| Detector precision / recall / F1 (face absence, multiple people, objects, speech, noise, tab switches) | Annotated sessions (`evaluation_trials` + `ground_truth_intervals`) | Event level: an alert is correct when it overlaps an annotated interval (±3 s video, ±2 s audio, ±1 s tabs); recall counts annotated intervals with at least one matching alert. Object labels must match when both are known. Face-absence intervals shorter than the grace period are reported separately and left out of recall. No TN/specificity: "non-events" are not countable. |
| False alerts per hour | Same | Unmatched alerts ÷ annotated session hours |
| Detection delay | Same | First matching alert start − annotated start |
| Identity FAR / FRR, manual-review rate, threshold sweep | Attempts labelled genuine/impostor (`identity_ground_truth`) | FAR = impostor attempts that *passed* ÷ impostor attempts; FRR = genuine attempts that did not pass ÷ genuine attempts (inconclusive → manual review counts as not passed) |
| Risk-score confusion matrix, precision, recall, F1, specificity, ROC-AUC (+ ROC curve) | Faculty outcomes (`session_reviews.outcome`: misconduct / no misconduct) | Score ≥ the exam's review threshold = flagged. Uses the score **recomputed without faculty dismissals** (`risk_evaluation_data()`), so reviewers' own event decisions don't leak into what is evaluated. ROC-AUC = Mann–Whitney, 95% CI by Hanley–McNeil |
| Rule-based vs learned model | Imported model cards from `train_risk_model.py` | Cross-validated ROC-AUC (mean ± std over folds) for both, plus pooled out-of-fold F1 |
| Processing latency | `monitoring_performance` (per-minute summaries from student browsers) | Per module: sample-weighted mean, median of per-minute medians, 95th percentile of per-minute p95s, max |
| Event logging delay | `proctoring_events` | Server receive time − client event time |
| Alert frequency, risk-score distribution, faculty dismissal rate | Logged data | Descriptive counts, explicitly **not** accuracy |

Every proportion is shown with its numerator/denominator and a Wilson 95%
confidence interval. With small samples these intervals are wide, and the
page says so.

### Collecting ground truth

1. Run the exam as usual (e.g. a scripted trial: a consenting participant follows a
   written timetable — *0:30 look away for 20 s, 1:10 hold up a phone…*).
2. On the Evaluation page, open **Ground truth → Annotate** for that session. Choose
   the data type, tick the categories you annotated **completely**, and enter
   what happened as offsets from the session start. Detector alerts are
   deliberately hidden on this page so the annotation is not anchored to them.
3. For identity, label attempts *genuine* or *impostor* only when you know who
   was in front of the camera (e.g. a consented impostor trial).
4. Record faculty outcomes on the Session review page as usual.

### Export (CSV)

The Evaluation page exports three CSV files:

- the **event log** (student, exam, type, category, severity, confidence,
  times, duration, review decision, evidence storage path, data type)
- the **evaluation results** (one row per metric with provenance, value,
  95% CI, n and notes)
- **risk scores** (live and review-independent score, threshold, outcome)

Cells that could be read as spreadsheet formulas are neutralised. Evidence
is exported as a private storage path, never as an image link. Every export
is written to `audit_log` because it contains personal data.

### Database objects (`phase6_patch_integrity_evaluation.sql`)

`evaluation_trials`, `ground_truth_intervals`, `identity_ground_truth`,
`monitoring_performance`, `model_evaluations` (all exam-owner only; students
can only insert their own latency summaries), `compute_risk_breakdown_ex()`,
`risk_evaluation_data()`, plus the integrity fixes listed under
[Security notes](#security-notes).

---

## Research integrity

- **Nothing is fabricated.** The repository contains no experimental results,
  benchmark numbers or trained models. Every figure on the Evaluation page is
  computed from your database at view time.
- **Provenance labels.** Every metric is shown and exported as one of:
  - **Measured**: real sessions compared with ground truth or faculty labels (live or scripted trials).
  - **Simulated**: sessions marked *simulated* (injected/synthetic events). This only checks the pipeline and says nothing about accuracy. These sessions are excluded from every other figure.
  - **Descriptive**: what the system logged, not accuracy.
  - **Not measured**: the required data does not exist. The page shows "—" with the reason, and the CSV leaves the value blank with the reason, never 0.
- **Placeholder values.** Test fixtures in `src/**/__tests__`, `tests/db` and
  `backend/ml/test_*` are hand-written inputs for checking the code. They are
  marked as such and must never be reported as results. The identity-match
  thresholds are uncalibrated defaults (see ML model setup).
- **Known biases to report alongside any result.** These include:
  - Faculty outcomes are not independent ground truth, because faculty saw the risk score.
  - Scripted trials are staged and may not reflect real behaviour.
  - Latency depends on student hardware.
  - Small samples give wide intervals.
- **Ethics.** Annotating sessions or running impostor trials involves personal data
  (faces, voices, behaviour). Obtain informed consent and any ethics approval
  your institution requires before collecting research data.

---

## Known limitations

**Detection (browser-side):**
- It cannot detect other devices, other applications, second screens,
  or anything outside the webcam's view.
- Tab/focus events show only that the exam lost focus, not where the student went.
- Object detection is a general COCO model (YOLOv8n). In an informal check
  on a handful of sample photos (not a benchmark) it found phones held up to
  the camera but missed small, edge-on or partly hidden ones, and it can
  mistake similar objects for a phone.
- Audio analysis cannot tell whose voice it hears. TV or music with vocals
  looks like speech, whispering may be missed, and browser noise suppression
  alters the signal.
- Monitoring runs on the student's device. Slow machines delay detection, and
  browsers throttle background tabs. All monitoring status is self-reported
  by the student's browser.

**Accuracy figures:** none exist until you collect labelled data (see Phase 6).

**Identity verification** compares one webcam frame with one reference photo
using uncalibrated thresholds. It has no liveness / anti-spoofing check, so a
photo of the student may pass.

**Scheduling:** exams saved before Phase 6 have no time zone, so their start
window is enforced only in the browser. Re-save the exam in the form to
record the faculty member's time zone and enforce it server-side. Time
allowed is always `duration_mins` from the student's actual start; late
starters are not cut off at the scheduled end.

**Automatic submission** of abandoned sessions needs either an open faculty
Monitor/Review page or the optional `pg_cron` job.

**Grading holds:** a "hold — further review" decision is recorded and shown,
but nothing in the app blocks grading; there is no faculty grading screen yet
(descriptive marks use `update_descriptive_marks()`).

**Sign-in by username** doesn't work under the current RLS rules
(anonymous users can't look up a username's email). Use email sign-in.
Fixing it means exposing a username→email lookup to anonymous users, which
is a privacy trade-off to decide deliberately.

**Latency for the final minute** of an exam may not be recorded: the last
summary is sent when monitoring stops, after the session has already closed.

**Not tested against hosted services:** see [Testing](#testing).

---

## Security notes

- The `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. **Never expose it in frontend code.**
- Every sign-up is a *student*; faculty are promoted manually. The backend
  reads roles from `profiles`, never from client-editable token metadata.
- All API routes requiring auth validate the Supabase JWT on the backend.
- Fixed in Phase 6 (`phase6_patch_integrity_evaluation.sql`, tested in
  `tests/db/phase6_security.test.js`):
  - **Grading:** students could set `is_correct` / `marks_awarded` on their own answers.
  - **Grading:** any signed-in user could call `update_descriptive_marks()` on any answer.
  - **Grading:** `auto_grade_session()` could be called on anyone's session.
  - **Questions:** students could read every question's `correct_answer`.
  - **Exam sessions:** students could delete their session, which cascade-deleted its proctoring evidence.
  - **Exam sessions:** students could reopen a submitted session, backdate their start, or keep editing answers after submission or time-out.
  - **Phase 6 base tables:** audit entries could be forged with any actor.
  - **Phase 6 base tables:** `system_metrics` was writable by any user.
  - **Phase 6 base tables:** feedback could be attached to someone else's session.
  - **Function access:** anonymous users could execute security-definer functions.
  - **Backend:** `require_role` trusted `user_metadata.role`, which the signup form sets, so any user could pass faculty checks.
- The CSV exports and evidence contain personal data; exports are audit-logged.

---

## Theme System

| Role    | Accent Color |
|---------|-------------|
| Student | Green (`#16a34a`) |
| Faculty | Amber (`#d97706`) |

Theme preference (light/dark) is persisted in `localStorage`.
