// Hand-written fixtures that exercise the report logic. Not experimental data.

import { describe, it, expect } from 'vitest'
import {
  buildReport, reportRows, riskScoringEvaluation, identityEvaluation, alertFrequencies,
  latencySummary, loggingDelay, reviewerAgreement, modelComparison, modelCardProblems, riskDistribution,
} from '../report'
import { toCsv, csvCell, RESULT_COLUMNS, EVENT_LOG_COLUMNS } from '../csv'

const T0 = Date.parse('2026-03-01T09:00:00Z')
const at = s => new Date(T0 + s * 1000).toISOString()
const NOW = T0 + 4 * 3600 * 1000

const EMPTY = { sessions: [], events: [], riskScores: [], riskEval: [], trials: [], intervals: [], identity: [], performance: [], modelCards: [] }

describe('with no data, nothing is reported as a number', () => {
  const report = buildReport(EMPTY, { now: NOW })
  it('every section is unavailable with a reason', () => {
    for (const s of [report.alerts, report.distribution, report.risk, report.loggingDelay, report.reviewers, report.models,
      ...report.identity, ...report.detectors, ...report.latency]) {
      expect(s.provenance).toBe('unavailable')
      expect(s.reason).toMatch(/\w/)
    }
  })
  it('the results CSV exports empty values with reasons, never 0', () => {
    const rows = reportRows(report)
    expect(rows.length).toBeGreaterThan(5)
    for (const r of rows) {
      expect(r.provenance).toBe('unavailable')
      expect(r.value).toBe('')
      expect(r.notes).toMatch(/\w/)
    }
  })
})

describe('risk scoring vs faculty outcomes', () => {
  const rows = [
    { exam_session_id: 'a', live_score: 10, score_without_reviews: 80, review_threshold: 40, outcome: 'misconduct' },
    { exam_session_id: 'b', score_without_reviews: 55, review_threshold: 40, outcome: 'no_misconduct' },
    { exam_session_id: 'c', score_without_reviews: 30, review_threshold: 40, outcome: 'misconduct' },
    { exam_session_id: 'd', score_without_reviews: 5,  review_threshold: 40, outcome: 'no_misconduct' },
    { exam_session_id: 'e', score_without_reviews: 90, review_threshold: 40, outcome: 'inconclusive' },
    { exam_session_id: 'f', score_without_reviews: 70, review_threshold: 40, outcome: null },
    { exam_session_id: 'sim', score_without_reviews: 99, review_threshold: 40, outcome: 'misconduct' },
  ]
  const r = riskScoringEvaluation(rows, { exclude: new Set(['sim']) })

  it('uses only definite outcomes and the score without review input', () => {
    expect(r.counts).toEqual({ closed_sessions: 6, labelled: 4, inconclusive: 1, unlabelled: 1 })
    expect(r.matrix).toEqual({ tp: 1, fp: 1, tn: 1, fn: 1 })   // 'a' counted with 80, not its live 10
    expect(r.metrics.precision.value).toBe(0.5)
    expect(r.roc_auc.value).toBe(0.75)
    expect(r.caveats.join(' ')).toMatch(/faculty saw the risk score/)
  })

  it('ROC-AUC is unavailable with a single class', () => {
    const one = riskScoringEvaluation(rows.slice(0, 1))
    expect(one.provenance).toBe('measured')
    expect(one.roc_auc.provenance).toBe('unavailable')
  })
})

describe('identity verification evaluation', () => {
  const a = (result, genuine, kind = 'scripted', distance = 0.5) => ({ result, distance, ground_truth: { is_genuine: genuine, data_kind: kind } })
  const rows = identityEvaluation([
    a('passed', true), a('passed', true), a('inconclusive', true), a('failed', true),
    a('passed', false), a('failed', false), a('failed', false), a('inconclusive', false),
    a('no_reference_face', true),
    a('passed', true, 'simulated'),
    { result: 'passed', distance: 0.4, ground_truth: null },
  ])
  it('reports each data kind separately', () => {
    expect(rows.map(r => [r.data_kind, r.provenance])).toEqual([['scripted', 'measured'], ['simulated', 'simulated']])
  })
  it('counts inconclusive as not accepted and keeps a 2×3 matrix', () => {
    const s = rows[0]
    expect(s.matrix).toEqual({ genuine: { passed: 2, inconclusive: 1, failed: 1 }, impostor: { passed: 1, inconclusive: 1, failed: 2 } })
    expect(s.far.value).toBe(0.25)
    expect(s.frr.value).toBe(0.5)
    expect(s.manual_review_rate.value).toBe(0.25)
    expect(s.undecidable).toBe(1)
  })
  it('is unavailable without labels', () => {
    expect(identityEvaluation([{ result: 'passed', ground_truth: null }])[0].provenance).toBe('unavailable')
  })
})

describe('descriptive sections', () => {
  const sessions = [
    { id: 's1', started_at: at(0), submitted_at: at(3600) },
    { id: 's2', started_at: at(0), submitted_at: null },          // open: counted up to now (4 h)
    { id: 'sim', started_at: at(0), submitted_at: at(3600) },
  ]
  const events = [
    { exam_session_id: 's1', event_type: 'tab_switch', occurred_at: at(10), created_at: at(11), review: { decision: 'dismissed' } },
    { exam_session_id: 's1', event_type: 'tab_switch', occurred_at: at(20), created_at: at(23), review: { decision: 'confirmed' } },
    { exam_session_id: 's2', event_type: 'phone_detected', occurred_at: at(30), created_at: at(30) },
    { exam_session_id: 'sim', event_type: 'phone_detected', occurred_at: at(5), created_at: at(5), review: { decision: 'dismissed' } },
  ]
  const exclude = new Set(['sim'])

  it('alert frequencies use monitored hours and exclude simulated sessions', () => {
    const f = alertFrequencies(events, sessions, { now: NOW, exclude })
    expect(f).toMatchObject({ provenance: 'descriptive', sessions: 2, monitored_hours: 5, total_alerts: 3, excluded_simulated: 1 })
    expect(f.rows.find(r => r.type === 'tab_switch')).toMatchObject({ count: 2, per_hour: 0.4, sessions: 1 })
  })

  it('logging delay is described with its clock caveat', () => {
    const d = loggingDelay(events, { exclude })
    expect(d).toMatchObject({ n: 3, median: 1, max: 3 })
    expect(d.caveat).toMatch(/clock/)
  })

  it('reviewer agreement is labelled as not ground truth', () => {
    const r = reviewerAgreement(events, sessions, { now: NOW, exclude })
    expect(r).toMatchObject({ reviewed: 2, dismissed: 1, dismissed_per_hour: 0.2 })
    expect(r.caveat).toMatch(/Not ground truth/)
  })

  it('risk distribution bins live scores and counts sessions at or above threshold', () => {
    const d = riskDistribution([
      { exam_session_id: 's1', score: 12, review_threshold: 40 }, { exam_session_id: 's2', score: 45, review_threshold: 40 },
      { exam_session_id: 'sim', score: 99, review_threshold: 40 },
    ], { exclude })
    expect(d.n).toBe(2)
    expect(d.at_or_above_threshold).toBe(1)
    expect(d.bins[1].count + d.bins[4].count).toBe(2)
  })

  it('latency pools windows with a sample-weighted mean', () => {
    const [face] = latencySummary([
      { exam_session_id: 's1', module: 'face', samples: 10, mean_ms: 100, p50_ms: 90, p95_ms: 150, max_ms: 200 },
      { exam_session_id: 's2', module: 'face', samples: 30, mean_ms: 60, p50_ms: 55, p95_ms: 80, max_ms: 120 },
      { exam_session_id: 'sim', module: 'face', samples: 99, mean_ms: 1, p50_ms: 1, p95_ms: 1, max_ms: 1 },
    ], { exclude })
    expect(face).toMatchObject({ windows: 2, sessions: 2, samples: 40, mean_ms: 70, max_ms: 200 })
  })
})

describe('model cards', () => {
  const card = {
    model: 'logistic', labelled_sessions: 60, status: 'experimental — not used for live scoring',
    cross_validation: { folds: 5, model: { roc_auc: { mean: 0.7, std: 0.1 } }, rule_based_score: { roc_auc: { mean: 0.65, std: 0.1 } } },
  }
  it('validates imported cards', () => {
    expect(modelCardProblems(card)).toEqual([])
    expect(modelCardProblems({ ...card, status: 'production' })).toHaveLength(1)
    expect(modelCardProblems({ labelled_sessions: 0 }).length).toBeGreaterThan(1)
    expect(modelCardProblems(null)).toEqual(['Not a JSON object.'])
  })
  it('comparison is unavailable without an imported card', () => {
    expect(modelComparison([], null).provenance).toBe('unavailable')
    expect(modelComparison([{ id: 1, card }], null).cards[0]).toMatchObject({ model: 'logistic', labelled_sessions: 60 })
  })
})

describe('CSV export', () => {
  it('escapes quotes, commas and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(NaN)).toBe('')
    expect(csvCell(-3.5)).toBe('-3.5')
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')
  })

  it('neutralises spreadsheet formulas in text', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`)
    for (const s of ['+1', '-1', '@SUM(A1)', '\tx']) expect(csvCell(s).replace(/^"/, '').startsWith("'")).toBe(true)
  })

  it('writes a header and one CRLF line per row', () => {
    const csv = toCsv([{ section: 'x', value: 0.5 }], RESULT_COLUMNS)
    expect(csv).toBe('section,metric,subset,provenance,value,ci_low,ci_high,n,notes\r\nx,,,,0.5,,,,\r\n')
  })

  it('exports events with student, category, duration, review and the private evidence path', () => {
    const csv = toCsv([{
      id: 'e1', exam_title: 'Algebra', student: { name: '=cmd', student_id: 'S1' }, exam_session_id: 's1',
      event_type: 'phone_detected', severity: 'high', confidence: '0.8100', occurred_at: at(0), ended_at: at(12),
      created_at: at(1), review: { decision: 'confirmed' }, snapshot: { storage_path: 's1/e1.jpg' }, metadata: { class_name: 'cell phone' },
    }], EVENT_LOG_COLUMNS)
    const [header, line] = csv.trim().split('\r\n')
    expect(header.split(',')).toContain('evidence_path')
    expect(line).toContain("'=cmd")
    expect(line).toContain(',object,high,0.81,')
    expect(line).toContain(',12,')
    expect(line).toContain('s1/e1.jpg')
    expect(line).toContain('live (no ground truth)')
  })
})
