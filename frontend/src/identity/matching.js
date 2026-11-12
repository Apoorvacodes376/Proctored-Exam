/**
 * matching.js
 * Face-embedding comparison used by VerificationGate, kept separate so
 * the decision rule can be unit-tested and evaluated (FAR/FRR) against
 * the same thresholds the app uses.
 *
 * The thresholds are the values chosen in Phase 3. They have NOT been
 * calibrated on measured data for this deployment; use the Evaluation
 * page (identity ground truth) to measure FAR/FRR at these settings.
 */

export const MATCH_THRESHOLD = 0.52        // distance ≤ this → passed
export const INCONCLUSIVE_THRESHOLD = 0.70 // ≤ this → inconclusive (manual review); above → failed

export function euclidean(a, b) {
  if (!a || !b || a.length !== b.length) throw new Error('embeddings must have the same length')
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2
  return Math.sqrt(sum)
}

/** 'passed' | 'inconclusive' | 'failed' for a face-embedding distance. */
export function classifyMatch(distance, { match = MATCH_THRESHOLD, inconclusive = INCONCLUSIVE_THRESHOLD } = {}) {
  if (!Number.isFinite(distance)) throw new Error('distance must be a number')
  if (distance <= match) return 'passed'
  if (distance <= inconclusive) return 'inconclusive'
  return 'failed'
}
