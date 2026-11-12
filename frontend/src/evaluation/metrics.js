/**
 * metrics.js
 * Pure evaluation metrics. Every function returns `null` (never 0) when
 * the metric is undefined for the data it was given — e.g. precision with
 * no positive predictions, or ROC-AUC with only one class — so a missing
 * measurement can never be mistaken for a measured zero.
 */

const Z95 = 1.959963984540054

/** Ratio or null when the denominator is 0. */
export function ratio(num, den) {
  return den > 0 ? num / den : null
}

/**
 * Wilson score interval for a binomial proportion (95% by default).
 * Better behaved than the normal approximation for small n or p near 0/1.
 * Returns null for n = 0.
 */
export function wilson(successes, n, z = Z95) {
  if (!(n > 0)) return null
  const p = successes / n
  const z2 = z * z
  const den = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

/** A proportion with its count, denominator and Wilson 95% CI. */
export function proportion(successes, n) {
  return { value: ratio(successes, n), successes, n, ci: wilson(successes, n) }
}

/** F1 from precision and recall (null if either is null or both are 0). */
export function f1(precision, recall) {
  if (precision == null || recall == null || precision + recall === 0) return null
  return (2 * precision * recall) / (precision + recall)
}

/** Binary confusion matrix from parallel arrays of labels (0/1) and predictions (0/1). */
export function confusionMatrix(labels, predictions) {
  if (labels.length !== predictions.length) throw new Error('labels and predictions differ in length')
  const m = { tp: 0, fp: 0, tn: 0, fn: 0 }
  labels.forEach((y, i) => {
    const p = predictions[i]
    if (y && p) m.tp++
    else if (!y && p) m.fp++
    else if (!y && !p) m.tn++
    else m.fn++
  })
  return m
}

/** Precision / recall / F1 / accuracy / specificity from a confusion matrix, with CIs. */
export function classificationMetrics({ tp, fp, tn = null, fn }) {
  const precision = proportion(tp, tp + fp)
  const recall = proportion(tp, tp + fn)
  return {
    precision,
    recall,
    f1: f1(precision.value, recall.value),
    specificity: tn == null ? null : proportion(tn, tn + fp),
    accuracy: tn == null ? null : proportion(tp + tn, tp + tn + fp + fn),
    support: { positives: tp + fn, negatives: tn == null ? null : tn + fp },
  }
}

/**
 * ROC-AUC via the Mann–Whitney U statistic (ties count ½), with the
 * Hanley & McNeil (1982) standard error for an approximate 95% CI.
 * Returns null unless both classes are present.
 */
export function rocAuc(labels, scores) {
  const pos = [], neg = []
  labels.forEach((y, i) => (y ? pos : neg).push(scores[i]))
  const nP = pos.length, nN = neg.length
  if (!nP || !nN) return null

  // Rank-based U: O(n log n).
  const all = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s)
  let rankSumPos = 0
  for (let i = 0; i < all.length;) {
    let j = i
    while (j + 1 < all.length && all[j + 1].s === all[i].s) j++
    const avgRank = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) if (all[k].y) rankSumPos += avgRank
    i = j + 1
  }
  const u = rankSumPos - (nP * (nP + 1)) / 2
  const auc = u / (nP * nN)

  const q1 = auc / (2 - auc), q2 = (2 * auc * auc) / (1 + auc)
  const variance = (auc * (1 - auc) + (nP - 1) * (q1 - auc * auc) + (nN - 1) * (q2 - auc * auc)) / (nP * nN)
  const se = Math.sqrt(Math.max(0, variance))
  return { value: auc, n_pos: nP, n_neg: nN, ci: [Math.max(0, auc - Z95 * se), Math.min(1, auc + Z95 * se)] }
}

/** ROC curve points [{ threshold, fpr, tpr }] (predict positive when score ≥ threshold). */
export function rocCurve(labels, scores) {
  const nP = labels.filter(Boolean).length, nN = labels.length - nP
  if (!nP || !nN) return []
  const thresholds = [...new Set(scores)].sort((a, b) => b - a)
  const points = [{ threshold: Infinity, fpr: 0, tpr: 0 }]
  for (const t of thresholds) {
    let tp = 0, fp = 0
    scores.forEach((s, i) => { if (s >= t) (labels[i] ? tp++ : fp++) })
    points.push({ threshold: t, fpr: fp / nN, tpr: tp / nP })
  }
  return points
}

/**
 * Biometric error rates for identity verification.
 * attempts: [{ genuine: boolean, accepted: boolean }]
 *   FAR = impostor attempts accepted / impostor attempts
 *   FRR = genuine attempts not accepted / genuine attempts
 */
export function farFrr(attempts) {
  const impostor = attempts.filter(a => !a.genuine)
  const genuine = attempts.filter(a => a.genuine)
  return {
    far: proportion(impostor.filter(a => a.accepted).length, impostor.length),
    frr: proportion(genuine.filter(a => !a.accepted).length, genuine.length),
  }
}

/** FAR/FRR across distance thresholds (accept when distance ≤ t). */
export function farFrrSweep(attempts, thresholds) {
  const usable = attempts.filter(a => Number.isFinite(a.distance))
  return thresholds.map(t => {
    const { far, frr } = farFrr(usable.map(a => ({ genuine: a.genuine, accepted: a.distance <= t })))
    return { threshold: t, far: far.value, frr: frr.value }
  })
}

/** Rate per hour, or null without observed time. */
export function perHour(count, seconds) {
  return seconds > 0 ? count / (seconds / 3600) : null
}

/** Nearest-rank percentile of unsorted numbers (p in 0..100). */
export function percentile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!xs.length) return null
  const rank = Math.ceil((p / 100) * xs.length)
  return xs[Math.min(xs.length, Math.max(1, rank)) - 1]
}

/** { n, mean, median, p95, max } of unsorted numbers, or null. */
export function describe(values) {
  const xs = values.filter(Number.isFinite)
  if (!xs.length) return null
  return {
    n: xs.length,
    mean: xs.reduce((s, x) => s + x, 0) / xs.length,
    median: percentile(xs, 50),
    p95: percentile(xs, 95),
    max: Math.max(...xs),
  }
}

/** Histogram counts over [min, max) bins of width `width`; the last bin includes max. */
export function histogram(values, { min = 0, max = 100, width = 10 } = {}) {
  const bins = []
  for (let lo = min; lo < max; lo += width) bins.push({ lo, hi: Math.min(max, lo + width), count: 0 })
  for (const v of values) {
    if (!Number.isFinite(v) || v < min || v > max) continue
    const i = Math.min(bins.length - 1, Math.floor((v - min) / width))
    bins[i].count++
  }
  return bins
}
