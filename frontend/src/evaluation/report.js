/**
 * report.js
 * Builds the Evaluation page's report from raw database rows. Pure and
 * deterministic (pass `now`), so every number shown can be reproduced in
 * a test.
 *
 * Provenance labels used throughout:
 *   measured     computed from real sessions against ground truth or
 *                faculty labels (live or scripted trials)
 *   simulated    computed from sessions marked data_kind = 'simulated';
 *                checks the pipeline only, says nothing about accuracy
 *   descriptive  counts of what the system logged — not accuracy
 *   unavailable  not computed; `reason` says what data is missing
 * Simulated sessions are excluded from every descriptive and measured
 * figure and reported only in their own rows.
 */

import {
  proportion, confusionMatrix, classificationMetrics, rocAuc, rocCurve,
  farFrr, farFrrSweep, perHour, describe, histogram, percentile,
} from './metrics'
import { evaluateDetectors, CATEGORY_OF_EVENT, EVAL_CATEGORIES } from './groundTruth'
import { MATCH_THRESHOLD } from '../identity/matching'

export const unavailable = reason => ({ provenance: 'unavailable', reason })

const ms = t => (t == null ? null : new Date(t).getTime())

/** Seconds each session was monitored (start → submission, or `now` while open). */
export function sessionSeconds(session, now) {
  const start = ms(session.started_at)
  if (start == null) return 0
  const end = ms(session.submitted_at) ?? now
  return Math.max(0, (end - start) / 1000)
}

/** Set of exam_session_ids that belong to simulated trials. */
export function simulatedSessionIds(trials) {
  return new Set(trials.filter(t => t.data_kind === 'simulated').map(t => t.exam_session_id))
}

// ── 1. Alert frequencies (descriptive) ───────────────────────
export function alertFrequencies(events, sessions, { now, exclude = new Set() }) {
  const real = sessions.filter(s => !exclude.has(s.id))
  if (!real.length) return unavailable('No exam sessions yet.')
  const ids = new Set(real.map(s => s.id))
  const seconds = real.reduce((s, x) => s + sessionSeconds(x, now), 0)
  const byType = new Map()
  for (const e of events) {
    if (!ids.has(e.exam_session_id)) continue
    const r = byType.get(e.event_type) ?? { type: e.event_type, count: 0, sessions: new Set() }
    r.count++
    r.sessions.add(e.exam_session_id)
    byType.set(e.event_type, r)
  }
  const rows = [...byType.values()]
    .map(r => ({ type: r.type, category: CATEGORY_OF_EVENT[r.type] ?? null, count: r.count,
                 per_hour: perHour(r.count, seconds), sessions: r.sessions.size }))
    .sort((a, b) => b.count - a.count)
  return {
    provenance: 'descriptive',
    sessions: real.length,
    monitored_hours: seconds / 3600,
    total_alerts: rows.reduce((s, r) => s + r.count, 0),
    rows,
    excluded_simulated: sessions.length - real.length,
  }
}

// ── 2. Risk-score distribution (descriptive) ────────────────
export function riskDistribution(riskRows, { exclude = new Set(), binWidth = 10 } = {}) {
  const rows = riskRows.filter(r => !exclude.has(r.exam_session_id) && Number.isFinite(Number(r.score)))
  if (!rows.length) return unavailable('No risk scores yet.')
  const scores = rows.map(r => Number(r.score))
  const thresholds = [...new Set(rows.map(r => Number(r.review_threshold)).filter(Number.isFinite))]
  return {
    provenance: 'descriptive',
    n: scores.length,
    bins: histogram(scores, { min: 0, max: 100, width: binWidth }),
    summary: describe(scores),
    review_thresholds: thresholds,
    at_or_above_threshold: rows.filter(r => Number(r.score) >= Number(r.review_threshold)).length,
  }
}

// ── 3. Risk scoring vs faculty outcomes (measured) ──────────
export const LABELS = { misconduct: 1, no_misconduct: 0 }

/**
 * rows: risk_evaluation_data() output — score_without_reviews is the score
 * recomputed with faculty dismissals ignored, so a reviewer's own
 * decisions do not leak into the score being evaluated.
 */
export function riskScoringEvaluation(rows, { exclude = new Set() } = {}) {
  const real = rows.filter(r => !exclude.has(r.exam_session_id))
  const labelled = real.filter(r => r.outcome in LABELS && Number.isFinite(Number(r.score_without_reviews)))
  const counts = {
    closed_sessions: real.length,
    labelled: labelled.length,
    inconclusive: real.filter(r => r.outcome === 'inconclusive').length,
    unlabelled: real.filter(r => !r.outcome).length,
  }
  if (!labelled.length) {
    return { ...unavailable('No closed sessions have a faculty outcome of "misconduct" or "no misconduct" yet.'), counts }
  }
  const y = labelled.map(r => LABELS[r.outcome])
  const scores = labelled.map(r => Number(r.score_without_reviews))
  const predictions = labelled.map((r, i) => (scores[i] >= Number(r.review_threshold) ? 1 : 0))
  const matrix = confusionMatrix(y, predictions)
  return {
    provenance: 'measured',
    counts,
    matrix,
    metrics: classificationMetrics(matrix),
    roc_auc: rocAuc(y, scores) ?? unavailable('ROC-AUC needs at least one session of each outcome.'),
    roc_curve: rocCurve(y, scores),
    caveats: [
      'Labels are faculty decisions, not independent ground truth; faculty saw the risk score when deciding.',
      'Scores are recomputed with faculty dismissals ignored to avoid leaking review decisions into the score.',
      ...(labelled.length < 30 ? [`Only ${labelled.length} labelled sessions: confidence intervals are wide.`] : []),
    ],
  }
}

// ── 4. Identity verification (measured / simulated) ─────────
const DECIDABLE = new Set(['passed', 'inconclusive', 'failed'])

export function identityEvaluation(attempts) {
  const labelled = attempts.filter(a => a.ground_truth && DECIDABLE.has(a.result))
  const undecidable = attempts.filter(a => a.ground_truth && !DECIDABLE.has(a.result)).length
  if (!labelled.length) {
    return [{ ...unavailable('No verification attempts have been labelled genuine or impostor.'),
              unlabelled: attempts.length, undecidable }]
  }
  const kinds = [...new Set(labelled.map(a => a.ground_truth.data_kind))].sort()
  return kinds.map(kind => {
    const rows = labelled.filter(a => a.ground_truth.data_kind === kind)
    const mapped = rows.map(a => ({
      genuine: a.ground_truth.is_genuine,
      accepted: a.result === 'passed',
      distance: a.distance == null ? NaN : Number(a.distance),
    }))
    const matrix = {}
    for (const g of ['genuine', 'impostor']) {
      matrix[g] = { passed: 0, inconclusive: 0, failed: 0 }
    }
    rows.forEach(a => { matrix[a.ground_truth.is_genuine ? 'genuine' : 'impostor'][a.result]++ })
    const { far, frr } = farFrr(mapped)
    const thresholds = Array.from({ length: 31 }, (_, i) => Math.round((0.3 + i * 0.02) * 100) / 100)
    return {
      provenance: kind === 'simulated' ? 'simulated' : 'measured',
      data_kind: kind,
      attempts: rows.length,
      genuine: mapped.filter(m => m.genuine).length,
      impostor: mapped.filter(m => !m.genuine).length,
      matrix,
      far, frr,
      manual_review_rate: proportion(rows.filter(a => a.result === 'inconclusive').length, rows.length),
      threshold: MATCH_THRESHOLD,
      sweep: farFrrSweep(mapped, thresholds),
      undecidable,
      notes: [
        'Accepted = "passed". Inconclusive attempts go to manual review and count as not accepted (they add to FRR for genuine users).',
        ...(rows.length < 30 ? [`Only ${rows.length} labelled attempts: confidence intervals are wide.`] : []),
      ],
    }
  })
}

// ── 5. Detectors vs ground truth (measured / simulated) ─────
export function detectorEvaluation(trials, intervals, events, sessionsById, matching) {
  if (!trials.length) return [unavailable('No sessions have been annotated with ground truth.')]
  const withSessions = trials.map(t => ({ ...t, session: sessionsById.get(t.exam_session_id) }))
  const rows = evaluateDetectors(withSessions, intervals, events, matching)
  if (!rows.length) return [unavailable('Annotated sessions have no annotated categories.')]
  return rows.map(r => ({ ...r, provenance: r.data_kind === 'simulated' ? 'simulated' : 'measured' }))
}

// ── 6. Processing latency (measured on client devices) ──────
export function latencySummary(perfRows, { exclude = new Set() } = {}) {
  const rows = perfRows.filter(r => !exclude.has(r.exam_session_id))
  if (!rows.length) return [unavailable('No latency measurements have been reported by student browsers yet.')]
  const modules = [...new Set(rows.map(r => r.module))].sort()
  return modules.map(module => {
    const rs = rows.filter(r => r.module === module)
    const samples = rs.reduce((s, r) => s + r.samples, 0)
    return {
      provenance: 'measured',
      module,
      windows: rs.length,
      sessions: new Set(rs.map(r => r.exam_session_id)).size,
      samples,
      mean_ms: rs.reduce((s, r) => s + Number(r.mean_ms) * r.samples, 0) / samples,
      median_of_window_p50_ms: percentile(rs.map(r => Number(r.p50_ms)), 50),
      p95_of_window_p95_ms: percentile(rs.map(r => Number(r.p95_ms)), 95),
      max_ms: Math.max(...rs.map(r => Number(r.max_ms))),
    }
  })
}

/** created_at (server receive) − occurred_at (client clock), seconds. */
export function loggingDelay(events, { exclude = new Set() } = {}) {
  const delays = events
    .filter(e => !exclude.has(e.exam_session_id) && e.created_at && e.occurred_at)
    .map(e => (ms(e.created_at) - ms(e.occurred_at)) / 1000)
  const d = describe(delays)
  if (!d) return unavailable('No logged events yet.')
  return {
    provenance: 'measured', ...d,
    caveat: 'Includes any offset between the student device clock and the server clock, and offline retry time.',
  }
}

// ── 7. Reviewer agreement (descriptive, not ground truth) ───
export function reviewerAgreement(events, sessions, { now, exclude = new Set() }) {
  const ids = new Set(sessions.filter(s => !exclude.has(s.id)).map(s => s.id))
  const reviewed = events.filter(e => ids.has(e.exam_session_id) && ['confirmed', 'dismissed'].includes(e.review?.decision))
  if (!reviewed.length) return unavailable('No alerts have been marked confirmed or dismissed by faculty.')
  const seconds = sessions.filter(s => ids.has(s.id)).reduce((s, x) => s + sessionSeconds(x, now), 0)
  const rows = EVAL_CATEGORIES.map(category => {
    const rs = reviewed.filter(e => CATEGORY_OF_EVENT[e.event_type] === category)
    const dismissed = rs.filter(e => e.review.decision === 'dismissed').length
    return { category, reviewed: rs.length, confirmed: rs.length - dismissed, dismissed,
             confirmed_share: proportion(rs.length - dismissed, rs.length) }
  }).filter(r => r.reviewed)
  const dismissed = reviewed.filter(e => e.review.decision === 'dismissed').length
  return {
    provenance: 'descriptive',
    reviewed: reviewed.length,
    dismissed,
    dismissed_per_hour: perHour(dismissed, seconds),
    rows,
    caveat: 'Faculty review decisions on the alerts they chose to review. Not ground truth: missed behaviour is invisible here and the reviewed subset may not be representative.',
  }
}

// ── 8. Rule-based vs learned model ──────────────────────────
export function modelComparison(cards, ruleEvaluation) {
  if (!cards.length) {
    return unavailable('No model evaluation has been imported. Run backend/ml/train_risk_model.py on real labelled sessions and import its model card.')
  }
  return {
    provenance: 'measured',
    rule_live: ruleEvaluation?.provenance === 'measured'
      ? { n: ruleEvaluation.counts.labelled, roc_auc: ruleEvaluation.roc_auc?.value ?? null, f1: ruleEvaluation.metrics.f1 }
      : null,
    cards: cards.map(c => ({
      id: c.id,
      imported_at: c.imported_at,
      exam_id: c.exam_id,
      model: c.card.model,
      created_at: c.card.created_at,
      labelled_sessions: c.card.labelled_sessions,
      folds: c.card.cross_validation?.folds,
      model_metrics: c.card.cross_validation?.model,
      rule_metrics: c.card.cross_validation?.rule_based_score,
      pooled: c.card.cross_validation?.pooled_out_of_fold ?? null,
      status: c.card.status,
      caveats: c.card.caveats ?? [],
    })),
    caveat: 'Model metrics are cross-validated inside train_risk_model.py on the labels available when it ran; the live rule-based figures use today\'s labels, so the two can differ in sample.',
  }
}

/** Validates the shape of an imported model card. Returns a list of problems. */
export function modelCardProblems(card) {
  const problems = []
  if (!card || typeof card !== 'object') return ['Not a JSON object.']
  if (!Number.isInteger(card.labelled_sessions) || card.labelled_sessions <= 0) problems.push('labelled_sessions must be a positive integer.')
  const cv = card.cross_validation
  if (!cv || typeof cv !== 'object') problems.push('cross_validation is missing.')
  else {
    for (const k of ['model', 'rule_based_score']) {
      const v = cv[k]?.roc_auc?.mean
      if (!(typeof v === 'number' && v >= 0 && v <= 1)) problems.push(`cross_validation.${k}.roc_auc.mean must be between 0 and 1.`)
    }
  }
  if (typeof card.status !== 'string' || !card.status.includes('experimental')) problems.push('status must mark the model as experimental (as train_risk_model.py does).')
  return problems
}

// ── Whole report ─────────────────────────────────────────────
export function buildReport(data, { now = Date.now(), matching = {} } = {}) {
  const exclude = simulatedSessionIds(data.trials)
  const sessionsById = new Map(data.sessions.map(s => [s.id, s]))
  const risk = riskScoringEvaluation(data.riskEval, { exclude })
  return {
    generated_at: new Date(now).toISOString(),
    data: {
      sessions: data.sessions.length,
      simulated_sessions: exclude.size,
      trials: countBy(data.trials, t => t.data_kind),
      identity_labelled: countBy(data.identity.filter(a => a.ground_truth), a => a.ground_truth.data_kind),
      outcomes: countBy(data.riskEval.filter(r => r.outcome), r => r.outcome),
      latency_windows: data.performance.length,
      model_cards: data.modelCards.length,
    },
    alerts: alertFrequencies(data.events, data.sessions, { now, exclude }),
    distribution: riskDistribution(data.riskScores, { exclude }),
    risk,
    identity: identityEvaluation(data.identity),
    detectors: detectorEvaluation(data.trials, data.intervals, data.events, sessionsById, matching),
    latency: latencySummary(data.performance, { exclude }),
    loggingDelay: loggingDelay(data.events, { exclude }),
    reviewers: reviewerAgreement(data.events, data.sessions, { now, exclude }),
    models: modelComparison(data.modelCards, risk),
  }
}

function countBy(xs, key) {
  const out = {}
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1
  return out
}

/**
 * Flatten a report into rows for the evaluation-results CSV. Every row
 * carries its provenance; unavailable metrics are exported with an empty
 * value and the reason, never as 0.
 */
export function reportRows(report) {
  const rows = []
  const add = (section, metric, provenance, value, extra = {}) =>
    rows.push({ section, metric, provenance, value: value ?? '', ci_low: '', ci_high: '', n: '', subset: '', notes: '', ...extra })
  const prop = (section, metric, provenance, p, subset, notes = '') => {
    if (!p) return add(section, metric, provenance, null, { subset, notes })
    add(section, metric, provenance, p.value, { ci_low: p.ci?.[0] ?? '', ci_high: p.ci?.[1] ?? '', n: p.n, subset, notes })
  }
  const na = (section, x) => add(section, 'not computed', 'unavailable', null, { notes: x.reason })

  if (report.alerts.provenance === 'unavailable') na('alert frequency', report.alerts)
  else for (const r of report.alerts.rows) {
    add('alert frequency', 'alerts', 'descriptive', r.count, { subset: r.type, n: r.sessions, notes: 'n = sessions with this alert' })
    add('alert frequency', 'alerts per monitored hour', 'descriptive', r.per_hour, { subset: r.type })
  }

  if (report.distribution.provenance === 'unavailable') na('risk distribution', report.distribution)
  else for (const b of report.distribution.bins) add('risk distribution', 'sessions', 'descriptive', b.count, { subset: `${b.lo}-${b.hi}` })

  const risk = report.risk
  if (risk.provenance === 'unavailable') na('risk scoring', risk)
  else {
    const { matrix: m, metrics: k } = risk
    for (const key of ['tp', 'fp', 'tn', 'fn']) add('risk scoring', key, 'measured', m[key], { notes: 'at the review threshold' })
    prop('risk scoring', 'precision', 'measured', k.precision)
    prop('risk scoring', 'recall', 'measured', k.recall)
    add('risk scoring', 'f1', 'measured', k.f1)
    if (risk.roc_auc?.provenance === 'unavailable') add('risk scoring', 'roc_auc', 'unavailable', null, { notes: risk.roc_auc.reason })
    else add('risk scoring', 'roc_auc', 'measured', risk.roc_auc.value, { ci_low: risk.roc_auc.ci[0], ci_high: risk.roc_auc.ci[1], n: risk.roc_auc.n_pos + risk.roc_auc.n_neg, notes: 'Hanley-McNeil 95% CI' })
  }

  for (const r of report.identity) {
    if (r.provenance === 'unavailable') { na('identity verification', r); continue }
    prop('identity verification', 'FAR', r.provenance, r.far, r.data_kind, `threshold ${r.threshold}`)
    prop('identity verification', 'FRR', r.provenance, r.frr, r.data_kind, `threshold ${r.threshold}`)
    prop('identity verification', 'manual review rate', r.provenance, r.manual_review_rate, r.data_kind)
  }

  for (const r of report.detectors) {
    if (r.provenance === 'unavailable') { na('detectors', r); continue }
    const subset = `${r.category} (${r.data_kind})`
    prop('detectors', 'precision', r.provenance, r.precision, subset, `tolerance ${r.matching.toleranceS}s`)
    prop('detectors', 'recall', r.provenance, r.recall, subset, r.ground_truth_too_short ? `${r.ground_truth_too_short} intervals shorter than ${r.matching.minDurationS}s excluded` : '')
    add('detectors', 'f1', r.provenance, r.f1, { subset })
    add('detectors', 'false alerts per hour', r.provenance, r.false_alerts_per_hour, { subset, n: r.false_alerts, notes: `${r.annotated_hours.toFixed(2)} annotated hours` })
    if (r.detection_delay_s) add('detectors', 'median detection delay (s)', r.provenance, r.detection_delay_s.median, { subset, n: r.detection_delay_s.n })
  }

  for (const r of report.latency) {
    if (r.provenance === 'unavailable') { na('latency', r); continue }
    add('latency', 'mean processing time (ms)', 'measured', r.mean_ms, { subset: r.module, n: r.samples, notes: 'student devices' })
    add('latency', 'median of per-minute p50 (ms)', 'measured', r.median_of_window_p50_ms, { subset: r.module, n: r.windows })
    add('latency', 'p95 of per-minute p95 (ms)', 'measured', r.p95_of_window_p95_ms, { subset: r.module, n: r.windows })
  }
  if (report.loggingDelay.provenance === 'unavailable') na('latency', report.loggingDelay)
  else add('latency', 'median event logging delay (s)', 'measured', report.loggingDelay.median, { subset: 'event logging', n: report.loggingDelay.n, notes: report.loggingDelay.caveat })

  if (report.reviewers.provenance === 'unavailable') na('reviewer agreement', report.reviewers)
  else {
    add('reviewer agreement', 'dismissed alerts per hour', 'descriptive', report.reviewers.dismissed_per_hour, { n: report.reviewers.dismissed, notes: report.reviewers.caveat })
    for (const r of report.reviewers.rows) prop('reviewer agreement', 'confirmed share', 'descriptive', r.confirmed_share, r.category)
  }

  if (report.models.provenance === 'unavailable') na('model comparison', report.models)
  else for (const c of report.models.cards) {
    add('model comparison', 'cv roc_auc (model)', 'measured', c.model_metrics?.roc_auc?.mean, { subset: c.model, n: c.labelled_sessions, notes: `±${c.model_metrics?.roc_auc?.std} over ${c.folds} folds` })
    add('model comparison', 'cv roc_auc (rule-based)', 'measured', c.rule_metrics?.roc_auc?.mean, { subset: c.model, n: c.labelled_sessions, notes: `±${c.rule_metrics?.roc_auc?.std} over ${c.folds} folds` })
  }
  return rows
}

