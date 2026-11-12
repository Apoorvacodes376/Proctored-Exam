import { describe, it, expect } from 'vitest'
import {
  ratio, wilson, proportion, f1, confusionMatrix, classificationMetrics, rocAuc, rocCurve,
  farFrr, farFrrSweep, perHour, percentile, describe as summarise, histogram,
} from '../metrics'
import { classifyMatch, euclidean, MATCH_THRESHOLD, INCONCLUSIVE_THRESHOLD } from '../../identity/matching'

describe('undefined metrics are null, never 0', () => {
  it('ratio / proportion / f1 / perHour', () => {
    expect(ratio(0, 0)).toBeNull()
    expect(proportion(0, 0)).toEqual({ value: null, successes: 0, n: 0, ci: null })
    expect(f1(null, 0.5)).toBeNull()
    expect(f1(0, 0)).toBeNull()
    expect(perHour(3, 0)).toBeNull()
    expect(percentile([], 50)).toBeNull()
    expect(summarise([NaN])).toBeNull()
  })
})

describe('Wilson interval', () => {
  it('matches the textbook value for 5/10', () => {
    const [lo, hi] = wilson(5, 10)
    expect(lo).toBeCloseTo(0.2366, 4)
    expect(hi).toBeCloseTo(0.7634, 4)
  })
  it('stays inside [0, 1] at the extremes', () => {
    expect(wilson(0, 5)[0]).toBe(0)
    expect(wilson(5, 5)[1]).toBe(1)
    expect(wilson(0, 5)[1]).toBeGreaterThan(0.4)   // 0/5 is far from proof of 0%
  })
})

describe('classification metrics', () => {
  it('builds a confusion matrix and derives precision, recall, F1, specificity, accuracy', () => {
    const m = confusionMatrix([1, 1, 1, 1, 1, 0, 0, 0, 0, 0], [1, 1, 1, 0, 0, 1, 0, 0, 0, 0])
    expect(m).toEqual({ tp: 3, fp: 1, tn: 4, fn: 2 })
    const k = classificationMetrics(m)
    expect(k.precision.value).toBe(0.75)
    expect(k.recall.value).toBe(0.6)
    expect(k.f1).toBeCloseTo(2 / 3, 10)
    expect(k.specificity.value).toBe(0.8)
    expect(k.accuracy.value).toBe(0.7)
    expect(k.precision.ci[0]).toBeLessThan(0.75)
  })

  it('omits TN-based metrics when TN is undefined', () => {
    const k = classificationMetrics({ tp: 2, fp: 1, fn: 1 })
    expect(k.specificity).toBeNull()
    expect(k.accuracy).toBeNull()
  })

  it('rejects mismatched inputs', () => {
    expect(() => confusionMatrix([1], [1, 0])).toThrow()
  })
})

describe('ROC-AUC', () => {
  it('computes the Mann–Whitney AUC', () => {
    expect(rocAuc([1, 1, 0, 0], [0.9, 0.4, 0.6, 0.1]).value).toBe(0.75)
    expect(rocAuc([1, 0], [1, 0]).value).toBe(1)
    expect(rocAuc([1, 1, 0, 0], [5, 5, 5, 5]).value).toBe(0.5)   // ties count half
  })
  it('is null without both classes', () => {
    expect(rocAuc([1, 1], [0.2, 0.3])).toBeNull()
    expect(rocCurve([0, 0], [1, 2])).toEqual([])
  })
  it('reports a CI that contains the estimate', () => {
    const r = rocAuc([1, 1, 1, 0, 0, 0], [0.9, 0.8, 0.3, 0.4, 0.2, 0.1])
    expect(r.ci[0]).toBeLessThanOrEqual(r.value)
    expect(r.ci[1]).toBeGreaterThanOrEqual(r.value)
    expect([r.n_pos, r.n_neg]).toEqual([3, 3])
  })
  it('ROC curve runs from (0,0) to (1,1)', () => {
    const c = rocCurve([1, 0, 1, 0], [0.8, 0.6, 0.4, 0.2])
    expect(c[0]).toMatchObject({ fpr: 0, tpr: 0 })
    expect(c.at(-1)).toMatchObject({ fpr: 1, tpr: 1 })
  })
})

describe('identity verification error rates', () => {
  const attempts = [
    { genuine: true, accepted: true, distance: 0.30 }, { genuine: true, accepted: true, distance: 0.40 },
    { genuine: true, accepted: true, distance: 0.45 }, { genuine: true, accepted: true, distance: 0.50 },
    { genuine: true, accepted: false, distance: 0.60 },
    { genuine: false, accepted: true, distance: 0.51 }, { genuine: false, accepted: false, distance: 0.75 },
    { genuine: false, accepted: false, distance: 0.80 }, { genuine: false, accepted: false, distance: 0.90 },
  ]
  it('FAR = accepted impostors / impostors, FRR = rejected genuine / genuine', () => {
    const { far, frr } = farFrr(attempts)
    expect(far.value).toBe(0.25)
    expect(frr.value).toBe(0.2)
    expect([far.n, frr.n]).toEqual([4, 5])
  })
  it('sweeps thresholds (FAR rises, FRR falls)', () => {
    const s = farFrrSweep(attempts, [0.2, 0.52, 1])
    expect(s[0]).toEqual({ threshold: 0.2, far: 0, frr: 1 })
    expect(s[1]).toEqual({ threshold: 0.52, far: 0.25, frr: 0.2 })
    expect(s[2]).toEqual({ threshold: 1, far: 1, frr: 0 })
  })
  it('the app decision rule matches its thresholds', () => {
    expect(classifyMatch(MATCH_THRESHOLD)).toBe('passed')
    expect(classifyMatch(0.6)).toBe('inconclusive')
    expect(classifyMatch(INCONCLUSIVE_THRESHOLD + 0.01)).toBe('failed')
    expect(() => classifyMatch(NaN)).toThrow()
    expect(euclidean([0, 3], [4, 0])).toBe(5)
    expect(() => euclidean([1], [1, 2])).toThrow()
  })
})

describe('descriptive helpers', () => {
  it('histogram puts the maximum in the last bin', () => {
    const bins = histogram([0, 9.9, 10, 100, -1, 101], { min: 0, max: 100, width: 10 })
    expect(bins).toHaveLength(10)
    expect(bins.map(b => b.count)).toEqual([2, 1, 0, 0, 0, 0, 0, 0, 0, 1])
  })
  it('describes a sample', () => {
    expect(summarise([4, 1, 3, 2])).toEqual({ n: 4, mean: 2.5, median: 2, p95: 4, max: 4 })
  })
})
