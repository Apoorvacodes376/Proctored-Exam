/**
 * groundTruth.js
 * Event-level evaluation of the monitoring detectors against annotated
 * ground-truth intervals (public.evaluation_trials / ground_truth_intervals).
 *
 * Definitions (per category, per data kind — kinds are never pooled):
 *   - an alert MATCHES a ground-truth interval when their time spans
 *     overlap, allowing `toleranceS` seconds either side;
 *   - precision = matched alerts / all alerts;
 *   - recall    = ground-truth intervals with ≥ 1 matching alert /
 *                 ground-truth intervals (intervals shorter than the
 *                 detector's designed minimum, e.g. the face grace period,
 *                 are reported separately and left out of recall);
 *   - false alerts per hour = unmatched alerts / annotated session hours;
 *   - detection delay = first matching alert start − interval start.
 * True negatives are not defined at event level (there is no countable
 * set of "non-events"), so no TN, specificity or accuracy is reported.
 *
 * Only categories listed in a trial's annotated_categories are evaluated
 * for that trial: an unannotated category is unknown, not empty.
 */

import { proportion, f1, perHour, describe } from './metrics'

export const CATEGORY_OF_EVENT = {
  face_not_detected: 'face_absence',
  multiple_faces:    'multiple_people',
  phone_detected:    'object',
  object_detected:   'object',
  speech_detected:   'speech',
  audio_detected:    'speech',
  unusual_noise:     'noise',
  tab_switch:        'tab_switch',
  focus_lost:        'tab_switch',
}

export const EVAL_CATEGORIES = ['face_absence', 'multiple_people', 'object', 'speech', 'noise', 'tab_switch']

export const CATEGORY_LABELS = {
  face_absence:    'Face absence',
  multiple_people: 'Multiple people',
  object:          'Prohibited objects',
  speech:          'Speech (audio)',
  noise:           'Loud noise (audio)',
  tab_switch:      'Tab / window switch',
}

/** Matching tolerance (s) and shortest interval the detector is designed to catch (s). */
export const DEFAULT_MATCHING = {
  face_absence:    { toleranceS: 3, minDurationS: 8 },   // VITE_FACE_GRACE_MS default
  multiple_people: { toleranceS: 3, minDurationS: 0 },
  object:          { toleranceS: 3, minDurationS: 0 },
  speech:          { toleranceS: 2, minDurationS: 0 },
  noise:           { toleranceS: 2, minDurationS: 0 },
  tab_switch:      { toleranceS: 1, minDurationS: 0 },
}

const ms = t => (t == null ? null : new Date(t).getTime())

function span(startIso, endIso) {
  const s = ms(startIso)
  const e = ms(endIso)
  return [s, e == null ? s : Math.max(s, e)]
}

function labelsCompatible(gtLabel, event) {
  const ev = event.metadata?.class_name
  if (!gtLabel || !ev) return true
  return gtLabel.trim().toLowerCase() === String(ev).trim().toLowerCase()
}

/**
 * Evaluate one category in one trial.
 * @returns {{ gt, gtExcludedShort, gtDetected, events, matched, delaysS: number[] }}
 */
export function matchCategory(intervals, events, { toleranceS = 0, minDurationS = 0, matchLabels = true } = {}) {
  const tol = toleranceS * 1000
  const gts = intervals.map(g => ({ ...g, span: span(g.starts_at, g.ends_at) }))
  const evs = events.map(e => ({ ...e, span: span(e.occurred_at, e.ended_at) }))

  const overlaps = (g, e) =>
    e.span[0] <= g.span[1] + tol && e.span[1] >= g.span[0] - tol && (!matchLabels || labelsCompatible(g.label, e))

  let matched = 0
  for (const e of evs) if (gts.some(g => overlaps(g, e))) matched++

  let gtCounted = 0, gtDetected = 0, gtExcludedShort = 0
  const delaysS = []
  for (const g of gts) {
    if ((g.span[1] - g.span[0]) / 1000 < minDurationS && g.ends_at != null) { gtExcludedShort++; continue }
    gtCounted++
    const hits = evs.filter(e => overlaps(g, e))
    if (hits.length) {
      gtDetected++
      delaysS.push((Math.min(...hits.map(h => h.span[0])) - g.span[0]) / 1000)
    }
  }
  return { gt: gtCounted, gtExcludedShort, gtDetected, events: evs.length, matched, delaysS }
}

/** Seconds a trial session was observed (start → submission, or last activity). */
export function trialSeconds(trial, events = [], intervals = []) {
  const start = ms(trial.session?.started_at)
  if (start == null) return 0
  let end = ms(trial.session?.submitted_at)
  if (end == null) {
    const times = [...events.flatMap(e => [ms(e.occurred_at), ms(e.ended_at)]),
                   ...intervals.flatMap(g => [ms(g.starts_at), ms(g.ends_at)])].filter(Number.isFinite)
    end = times.length ? Math.max(...times) : start
  }
  return Math.max(0, (end - start) / 1000)
}

/**
 * Evaluate every trial and aggregate per data kind and category.
 * @param {Array<{ id, data_kind, annotated_categories, session: {started_at, submitted_at} }>} trials
 * @param {Array<{ trial_id, category, starts_at, ends_at, label }>} intervals
 * @param {Array<{ exam_session_id, event_type, occurred_at, ended_at, metadata }>} events
 * @param {object} [matching]  per-category overrides of DEFAULT_MATCHING
 * @returns {Array<object>} one row per (data_kind, category) that was annotated
 */
export function evaluateDetectors(trials, intervals, events, matching = {}) {
  const acc = new Map()
  for (const trial of trials) {
    const sessionEvents = events.filter(e => e.exam_session_id === trial.exam_session_id)
    const trialIntervals = intervals.filter(g => g.trial_id === trial.id)
    const seconds = trialSeconds(trial, sessionEvents, trialIntervals)

    for (const category of trial.annotated_categories ?? []) {
      if (!EVAL_CATEGORIES.includes(category)) continue
      const opts = { ...DEFAULT_MATCHING[category], ...matching[category] }
      const r = matchCategory(
        trialIntervals.filter(g => g.category === category),
        sessionEvents.filter(e => CATEGORY_OF_EVENT[e.event_type] === category),
        opts,
      )
      const key = `${trial.data_kind}|${category}`
      const a = acc.get(key) ?? { data_kind: trial.data_kind, category, trials: 0, seconds: 0,
        gt: 0, gtExcludedShort: 0, gtDetected: 0, events: 0, matched: 0, delaysS: [], options: opts }
      a.trials++; a.seconds += seconds
      a.gt += r.gt; a.gtExcludedShort += r.gtExcludedShort; a.gtDetected += r.gtDetected
      a.events += r.events; a.matched += r.matched; a.delaysS.push(...r.delaysS)
      acc.set(key, a)
    }
  }

  return [...acc.values()].map(a => {
    const precision = proportion(a.matched, a.events)
    const recall = proportion(a.gtDetected, a.gt)
    const falseAlerts = a.events - a.matched
    return {
      data_kind: a.data_kind,
      category: a.category,
      trials: a.trials,
      annotated_hours: a.seconds / 3600,
      ground_truth: a.gt,
      ground_truth_too_short: a.gtExcludedShort,
      detected: a.gtDetected,
      missed: a.gt - a.gtDetected,
      alerts: a.events,
      matched_alerts: a.matched,
      false_alerts: falseAlerts,
      precision,
      recall,
      f1: f1(precision.value, recall.value),
      false_alerts_per_hour: perHour(falseAlerts, a.seconds),
      detection_delay_s: describe(a.delaysS),
      matching: a.options,
    }
  }).sort((x, y) => x.data_kind.localeCompare(y.data_kind) || EVAL_CATEGORIES.indexOf(x.category) - EVAL_CATEGORIES.indexOf(y.category))
}
