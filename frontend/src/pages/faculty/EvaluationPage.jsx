/**
 * EvaluationPage.jsx — Phase 6 research evaluation.
 *
 * Every figure is computed in src/evaluation/* from rows in the database
 * and carries a provenance badge (measured / simulated / descriptive /
 * not measured). Nothing on this page is a placeholder number: when the
 * data a metric needs does not exist, the page says so instead.
 */

import { useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Loader2, RefreshCw, Download, Upload, Trash2, Info, PencilLine, AlertCircle } from 'lucide-react'
import FacultyLayout from '../../components/FacultyLayout'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../lib/supabase'
import { useFacultyExams } from '../../hooks/useExamSessions'
import { useEvaluationData } from '../../hooks/useEvaluationData'
import { Card, NotProofNotice } from '../../components/review/ReviewUI'
import { ProvenanceBadge, Unavailable, BarChart, Histogram, LineChart, ConfusionMatrix, Prop, fmt } from '../../components/evaluation/Charts'
import { buildReport, reportRows, modelCardProblems } from '../../evaluation/report'
import { toCsv, downloadCsv, EVENT_LOG_COLUMNS, RESULT_COLUMNS, RISK_COLUMNS } from '../../evaluation/csv'
import { CATEGORY_LABELS } from '../../evaluation/groundTruth'
import { EVENT_LABELS } from '../../review/riskView'

const KIND_LABELS = { live: 'Live session', scripted: 'Scripted trial', simulated: 'Simulated' }
const MODULE_LABELS = { face: 'Face detection (per frame)', objects: 'Object detection (per frame)', audio: 'Audio VAD (per window)' }

function Th({ children, className = '' }) {
  return <th className={`px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 ${className}`}>{children}</th>
}
function Td({ children, className = '' }) {
  return <td className={`px-3 py-2 text-sm text-gray-800 dark:text-gray-200 align-top ${className}`}>{children}</td>
}
function Table({ head, children }) {
  return (
    <div className="overflow-x-auto -mx-5 px-5">
      <table className="w-full min-w-max">
        <thead className="border-b border-gray-200 dark:border-gray-800"><tr>{head.map(h => <Th key={h}>{h}</Th>)}</tr></thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">{children}</tbody>
      </table>
    </div>
  )
}
function Caveats({ items }) {
  if (!items?.length) return null
  return (
    <ul className="mt-3 space-y-1 text-xs text-gray-500 dark:text-gray-400 list-disc pl-5">
      {items.map(c => <li key={c}>{c}</li>)}
    </ul>
  )
}
function Section({ title, provenance, children, actions }) {
  return (
    <Card title={<span className="inline-flex items-center gap-2">{title}{provenance && <ProvenanceBadge provenance={provenance} />}</span>} actions={actions}>
      {children}
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────
export default function EvaluationPage() {
  const { profile } = useAuth()
  const { exams, loading: examsLoading } = useFacultyExams(profile?.id)
  const [params, setParams] = useSearchParams()
  const scope = params.get('exam') ?? ''
  const selected = useMemo(
    () => (scope === 'all' ? exams : exams.filter(e => e.id === scope)), [scope, exams])
  const { data, loading, error, reload } = useEvaluationData(selected)
  const report = useMemo(() => (data ? buildReport(data) : null), [data])
  const [exportMsg, setExportMsg] = useState('')

  async function exportCsv(kind) {
    const stamp = new Date().toISOString().slice(0, 10)
    const name = scope === 'all' ? 'all-exams' : (selected[0]?.title ?? 'exam').replace(/[^\w-]+/g, '-').toLowerCase()
    let csv, rows
    if (kind === 'events') { rows = data.events.length; csv = toCsv(data.events, EVENT_LOG_COLUMNS) }
    if (kind === 'risk')   { rows = data.riskEval.length; csv = toCsv(data.riskEval, RISK_COLUMNS) }
    if (kind === 'results') {
      const meta = [
        { section: 'about', metric: 'generated_at', provenance: 'descriptive', value: report.generated_at },
        { section: 'about', metric: 'exams', provenance: 'descriptive', value: selected.map(e => e.title).join('; ') },
        { section: 'about', metric: 'provenance key', provenance: 'descriptive', value: '',
          notes: 'measured = real sessions vs ground truth/faculty labels; simulated = pipeline check only; descriptive = logged counts, not accuracy; unavailable = not computed (no data)' },
      ]
      const body = reportRows(report)
      rows = body.length
      csv = toCsv([...meta, ...body], RESULT_COLUMNS)
    }
    downloadCsv(`${kind === 'events' ? 'event-log' : kind === 'risk' ? 'risk-scores' : 'evaluation-results'}_${name}_${stamp}.csv`, csv)
    // Exports contain personal data: record who exported what.
    const { error: auditErr } = await supabase.from('audit_log').insert({
      action: `export.${kind}_csv`, target_table: 'exams', target_id: scope === 'all' ? null : scope,
      metadata: { exam_ids: selected.map(e => e.id), rows },
    })
    setExportMsg(auditErr ? `Exported, but the export could not be logged: ${auditErr.message}` : `Exported ${rows} rows.`)
  }

  return (
    <FacultyLayout>
      <div className="p-8 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">Evaluation</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Research metrics computed from your exams — only where labelled data exists.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={scope} onChange={e => setParams(e.target.value ? { exam: e.target.value } : {})}
              className="px-3 py-2 text-sm rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500 max-w-full">
              <option value="">Select an exam…</option>
              <option value="all">All my exams</option>
              {exams.map(e => <option key={e.id} value={e.id}>{e.title} — {e.subject} ({e.exam_date})</option>)}
            </select>
            {data && (
              <button onClick={reload} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
              </button>
            )}
          </div>
        </div>

        <IntegrityNotice />

        {!scope && !examsLoading && <p className="text-sm text-gray-500 dark:text-gray-400">Choose an exam, or all of your exams, to evaluate.</p>}
        {loading && !data && <div className="flex justify-center py-16"><Loader2 className="animate-spin text-amber-500" /></div>}
        {error && (
          <div className="flex items-start gap-2 px-4 py-3 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-sm text-red-700 dark:text-red-300">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <p>Could not load evaluation data: {error}. Has <code>phase6_patch_integrity_evaluation.sql</code> been applied?</p>
          </div>
        )}

        {data && report && (
          <>
            <Section title="Export" actions={exportMsg && <span className="text-xs text-gray-500 dark:text-gray-400">{exportMsg}</span>}>
              <div className="flex flex-wrap gap-2">
                <ExportButton onClick={() => exportCsv('events')} disabled={!data.events.length}>Event log ({data.events.length})</ExportButton>
                <ExportButton onClick={() => exportCsv('results')}>Evaluation results</ExportButton>
                <ExportButton onClick={() => exportCsv('risk')} disabled={!data.riskEval.length}>Risk scores ({data.riskEval.length})</ExportButton>
              </div>
              <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                Exports contain student names and IDs; each export is recorded in the audit log. Evidence is exported as private storage paths, not image links.
                Every result row carries its provenance; unavailable metrics are exported blank with the reason, never as 0.
              </p>
            </Section>

            <DataSummary report={report} />
            <AlertsSection alerts={report.alerts} />
            <DistributionSection distribution={report.distribution} />
            <DetectorSection rows={report.detectors} />
            <IdentitySection rows={report.identity} />
            <RiskSection risk={report.risk} />
            <ModelSection models={report.models} examId={scope === 'all' ? null : scope} onChange={reload} />
            <LatencySection rows={report.latency} logging={report.loggingDelay} />
            <ReviewerSection reviewers={report.reviewers} />
            <GroundTruthSection data={data} onChange={reload} />
            <NotProofNotice />
          </>
        )}
      </div>
    </FacultyLayout>
  )
}

function ExportButton({ children, ...props }) {
  return (
    <button {...props} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-40 disabled:cursor-not-allowed">
      <Download size={14} /> {children}
    </button>
  )
}

function IntegrityNotice() {
  return (
    <div className="flex items-start gap-2 px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-300">
      <Info size={16} strokeWidth={1.75} className="shrink-0 mt-0.5 text-amber-600" />
      <div className="space-y-2">
        <p>
          Accuracy metrics need <strong>ground truth</strong>: what actually happened, recorded independently of the detectors
          (annotated sessions below), and <strong>faculty outcomes</strong> for risk scoring. Until that data exists the metric is shown as
          not measured. Sessions marked <em>simulated</em> are kept out of every other figure.
        </p>
        <p className="flex flex-wrap gap-2">
          <ProvenanceBadge provenance="measured" /> <ProvenanceBadge provenance="simulated" />
          <ProvenanceBadge provenance="descriptive" /> <ProvenanceBadge provenance="unavailable" />
        </p>
      </div>
    </div>
  )
}

function DataSummary({ report }) {
  const d = report.data
  const kinds = k => Object.entries(k).map(([kind, n]) => `${n} ${KIND_LABELS[kind]?.toLowerCase() ?? kind}`).join(', ') || 'none'
  const items = [
    ['Exam sessions', `${d.sessions}${d.simulated_sessions ? ` (${d.simulated_sessions} simulated, excluded)` : ''}`],
    ['Annotated sessions (ground truth)', kinds(d.trials)],
    ['Labelled identity attempts', kinds(d.identity_labelled)],
    ['Faculty outcomes', Object.entries(d.outcomes).map(([o, n]) => `${n} ${o.replace('_', ' ')}`).join(', ') || 'none'],
    ['Latency reports (1-min windows)', d.latency_windows],
    ['Imported model evaluations', d.model_cards],
  ]
  return (
    <Section title="Data available">
      <dl className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
        {items.map(([k, v]) => (
          <div key={k}><dt className="text-xs text-gray-500 dark:text-gray-400">{k}</dt><dd className="text-sm text-gray-900 dark:text-white">{v}</dd></div>
        ))}
      </dl>
    </Section>
  )
}

function AlertsSection({ alerts }) {
  return (
    <Section title="Alert frequency" provenance={alerts.provenance}>
      {alerts.provenance === 'unavailable' ? <Unavailable reason={alerts.reason} /> : (
        <>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            {alerts.total_alerts} alerts over {fmt(alerts.monitored_hours, 1)} monitored hours in {alerts.sessions} sessions.
            These are what the detectors reported — not how often the behaviour actually happened.
          </p>
          {alerts.rows.length ? (
            <BarChart rows={alerts.rows.map(r => ({
              label: EVENT_LABELS[r.type] ?? r.type, value: r.count,
              sub: `${fmt(r.per_hour, 2)}/h · ${r.sessions} session${r.sessions === 1 ? '' : 's'}`,
            }))} />
          ) : <p className="text-sm text-gray-500">No alerts were logged.</p>}
        </>
      )}
    </Section>
  )
}

function DistributionSection({ distribution: d }) {
  return (
    <Section title="Risk-score distribution" provenance={d.provenance}>
      {d.provenance === 'unavailable' ? <Unavailable reason={d.reason} /> : (
        <>
          <Histogram bins={d.bins} thresholds={d.review_thresholds} />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            {d.n} sessions · median {fmt(d.summary.median, 1)} · {d.at_or_above_threshold} at or above their review threshold (live scores).
          </p>
        </>
      )}
    </Section>
  )
}

function DetectorSection({ rows }) {
  const unavailable = rows[0]?.provenance === 'unavailable'
  return (
    <Section title="Detection accuracy vs ground truth" provenance={unavailable ? 'unavailable' : null}>
      {unavailable ? <Unavailable reason={rows[0].reason} /> : (
        <>
          <Table head={['Category', 'Data', 'Precision', 'Recall', 'F1', 'False alerts / h', 'Median delay', 'Ground truth', 'Alerts']}>
            {rows.map(r => (
              <tr key={`${r.data_kind}-${r.category}`}>
                <Td>{CATEGORY_LABELS[r.category]}</Td>
                <Td><span className="inline-flex flex-col gap-1">{KIND_LABELS[r.data_kind]} <ProvenanceBadge provenance={r.provenance} /></span></Td>
                <Td><Prop p={r.precision} /></Td>
                <Td><Prop p={r.recall} /></Td>
                <Td>{fmt(r.f1, 3)}</Td>
                <Td>{fmt(r.false_alerts_per_hour, 2)} <span className="text-xs text-gray-400">({r.false_alerts} in {fmt(r.annotated_hours, 2)} h)</span></Td>
                <Td>{r.detection_delay_s ? `${fmt(r.detection_delay_s.median, 1)} s` : '—'}</Td>
                <Td>{r.detected}/{r.ground_truth} detected{r.ground_truth_too_short ? <span className="block text-xs text-gray-400">{r.ground_truth_too_short} shorter than {r.matching.minDurationS}s excluded</span> : null}</Td>
                <Td>{r.matched_alerts}/{r.alerts} matched</Td>
              </tr>
            ))}
          </Table>
          <Caveats items={[
            'Event level: an alert counts as correct when it overlaps an annotated interval (±3 s for video detectors, ±2 s audio, ±1 s tabs). True negatives are not defined at this level, so no specificity or accuracy is reported.',
            'Recall is computed only for categories each trial marked as completely annotated.',
            'Results depend on lighting, camera, room and participants in the annotated sessions and may not generalise.',
          ]} />
        </>
      )}
    </Section>
  )
}

function IdentitySection({ rows }) {
  if (rows[0]?.provenance === 'unavailable') {
    return <Section title="Identity verification (FAR / FRR)" provenance="unavailable"><Unavailable reason={rows[0].reason} /></Section>
  }
  return (
    <Section title="Identity verification (FAR / FRR)">
      <div className="space-y-6">
        {rows.map(r => (
          <div key={r.data_kind} className="space-y-3">
            <p className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white">{KIND_LABELS[r.data_kind]} <ProvenanceBadge provenance={r.provenance} /></p>
            <div className="grid lg:grid-cols-2 gap-6">
              <div className="space-y-3">
                <ConfusionMatrix rowTitle="Actual" colTitle="Verification result" rows={['Genuine', 'Impostor']} cols={['Passed', 'Inconclusive', 'Failed']}
                  cells={['genuine', 'impostor'].map(g => ['passed', 'inconclusive', 'failed'].map(k => r.matrix[g][k]))}
                  highlight={(i, j) => (i === 0 && j === 0) || (i === 1 && j === 2)} />
                <dl className="text-sm space-y-1">
                  <div><dt className="inline text-gray-500 dark:text-gray-400">False acceptance rate: </dt><dd className="inline"><Prop p={r.far} /></dd></div>
                  <div><dt className="inline text-gray-500 dark:text-gray-400">False rejection rate: </dt><dd className="inline"><Prop p={r.frr} /></dd></div>
                  <div><dt className="inline text-gray-500 dark:text-gray-400">Sent to manual review: </dt><dd className="inline"><Prop p={r.manual_review_rate} /></dd></div>
                </dl>
              </div>
              <LineChart xLabel="Distance threshold" yLabel="Error rate" xDomain={[0.3, 0.9]}
                markers={[{ x: r.threshold, label: `in use: ${r.threshold}` }]}
                series={[
                  { name: 'FAR (impostors accepted)', points: r.sweep.map(s => ({ x: s.threshold, y: s.far })) },
                  { name: 'FRR (genuine rejected)', points: r.sweep.map(s => ({ x: s.threshold, y: s.frr })) },
                ]} />
            </div>
            <Caveats items={r.notes} />
          </div>
        ))}
      </div>
    </Section>
  )
}

function RiskSection({ risk }) {
  return (
    <Section title="Risk scoring vs faculty outcomes" provenance={risk.provenance}>
      {risk.provenance === 'unavailable' ? (
        <>
          <Unavailable reason={risk.reason} />
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{risk.counts.closed_sessions} closed sessions; {risk.counts.inconclusive} inconclusive, {risk.counts.unlabelled} without an outcome.</p>
        </>
      ) : (
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="space-y-3">
            <ConfusionMatrix rowTitle="Faculty outcome" colTitle="Score at or above review threshold?" rows={['Misconduct', 'No misconduct']} cols={['Flagged', 'Not flagged']}
              cells={[[risk.matrix.tp, risk.matrix.fn], [risk.matrix.fp, risk.matrix.tn]]} highlight={(i, j) => i === j} />
            <dl className="text-sm space-y-1">
              <div><dt className="inline text-gray-500 dark:text-gray-400">Precision: </dt><dd className="inline"><Prop p={risk.metrics.precision} /></dd></div>
              <div><dt className="inline text-gray-500 dark:text-gray-400">Recall: </dt><dd className="inline"><Prop p={risk.metrics.recall} /></dd></div>
              <div><dt className="inline text-gray-500 dark:text-gray-400">F1: </dt><dd className="inline">{fmt(risk.metrics.f1, 3)}</dd></div>
              <div><dt className="inline text-gray-500 dark:text-gray-400">Specificity: </dt><dd className="inline"><Prop p={risk.metrics.specificity} /></dd></div>
              <div><dt className="inline text-gray-500 dark:text-gray-400">ROC-AUC: </dt><dd className="inline">
                {risk.roc_auc.provenance === 'unavailable' ? <span className="text-gray-400">— ({risk.roc_auc.reason})</span>
                  : <>{fmt(risk.roc_auc.value, 3)} <span className="text-xs text-gray-400">(95% CI {fmt(risk.roc_auc.ci[0], 2)}–{fmt(risk.roc_auc.ci[1], 2)}; {risk.roc_auc.n_pos} misconduct, {risk.roc_auc.n_neg} not)</span></>}
              </dd></div>
            </dl>
            <p className="text-xs text-gray-500 dark:text-gray-400">{risk.counts.labelled} labelled of {risk.counts.closed_sessions} closed sessions ({risk.counts.inconclusive} inconclusive and {risk.counts.unlabelled} unlabelled not used).</p>
          </div>
          {risk.roc_curve.length > 0 && (
            <LineChart xLabel="False positive rate" yLabel="True positive rate" diagonal step
              series={[{ name: 'Rule-based score', points: risk.roc_curve.map(p => ({ x: p.fpr, y: p.tpr })) }]} />
          )}
          <div className="lg:col-span-2"><Caveats items={risk.caveats} /></div>
        </div>
      )}
    </Section>
  )
}

function ModelSection({ models, examId, onChange }) {
  const fileRef = useRef(null)
  const [msg, setMsg] = useState('')

  async function importCard(file) {
    setMsg('')
    try {
      const card = JSON.parse(await file.text())
      const problems = modelCardProblems(card)
      if (problems.length) { setMsg(`Not imported: ${problems.join(' ')}`); return }
      const { error } = await supabase.from('model_evaluations').insert({ exam_id: examId, card })
      if (error) throw error
      setMsg('Imported.')
      onChange()
    } catch (err) {
      setMsg(`Not imported: ${err.message}`)
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  async function remove(id) {
    const { error } = await supabase.from('model_evaluations').delete().eq('id', id)
    if (error) setMsg(error.message); else onChange()
  }

  return (
    <Section title="Rule-based vs learned model" provenance={models.provenance}
      actions={
        <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer">
          <Upload size={13} /> Import model card
          <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={e => e.target.files?.[0] && importCard(e.target.files[0])} />
        </label>
      }>
      {msg && <p className="text-xs mb-3 text-gray-600 dark:text-gray-400">{msg}</p>}
      {models.provenance === 'unavailable' ? <Unavailable reason={models.reason} /> : (
        <>
          <Table head={['Model', 'Labelled sessions', 'CV ROC-AUC (model)', 'CV ROC-AUC (rule-based)', 'Pooled out-of-fold F1 (model / rule)', 'Imported', '']}>
            {models.cards.map(c => (
              <tr key={c.id}>
                <Td>{c.model}<span className="block text-xs text-gray-400">{c.status}</span></Td>
                <Td>{c.labelled_sessions} <span className="text-xs text-gray-400">({c.folds} folds)</span></Td>
                <Td>{fmt(c.model_metrics?.roc_auc?.mean, 3)} ± {fmt(c.model_metrics?.roc_auc?.std, 3)}</Td>
                <Td>{fmt(c.rule_metrics?.roc_auc?.mean, 3)} ± {fmt(c.rule_metrics?.roc_auc?.std, 3)}</Td>
                <Td>{c.pooled ? `${fmt(c.pooled['model_at_0.5']?.f1, 3)} / ${fmt(c.pooled.rule_at_review_threshold?.f1, 3)}` : '—'}</Td>
                <Td>{new Date(c.imported_at).toLocaleDateString()}</Td>
                <Td><button onClick={() => remove(c.id)} className="text-gray-400 hover:text-red-600" title="Remove"><Trash2 size={14} /></button></Td>
              </tr>
            ))}
          </Table>
          {models.rule_live && (
            <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
              Rule-based score on today's labels: ROC-AUC {fmt(models.rule_live.roc_auc, 3)}, F1 {fmt(models.rule_live.f1, 3)} (n = {models.rule_live.n}).
            </p>
          )}
          <Caveats items={[models.caveat, 'The learned model is experimental and is never used for live scoring.']} />
        </>
      )}
    </Section>
  )
}

function LatencySection({ rows, logging }) {
  const unavailable = rows[0]?.provenance === 'unavailable'
  return (
    <Section title="Processing latency" provenance={unavailable ? 'unavailable' : 'measured'}>
      {unavailable ? <Unavailable reason={rows[0].reason} /> : (
        <Table head={['Module', 'Mean', 'Median (of 1-min medians)', 'p95 (of 1-min p95s)', 'Max', 'Samples', 'Sessions']}>
          {rows.map(r => (
            <tr key={r.module}>
              <Td>{MODULE_LABELS[r.module] ?? r.module}</Td>
              <Td>{fmt(r.mean_ms, 1)} ms</Td>
              <Td>{fmt(r.median_of_window_p50_ms, 1)} ms</Td>
              <Td>{fmt(r.p95_of_window_p95_ms, 1)} ms</Td>
              <Td>{fmt(r.max_ms, 1)} ms</Td>
              <Td>{r.samples}</Td>
              <Td>{r.sessions}</Td>
            </tr>
          ))}
        </Table>
      )}
      <div className="mt-4 text-sm text-gray-700 dark:text-gray-300">
        {logging.provenance === 'unavailable' ? <Unavailable reason={logging.reason} /> : (
          <p>Event logging delay (alert → stored on server): median {fmt(logging.median, 2)} s, p95 {fmt(logging.p95, 2)} s over {logging.n} events.</p>
        )}
      </div>
      <Caveats items={[
        "Measured with performance.now() in each student's browser: results depend on their hardware and on browser throttling of background tabs.",
        ...(logging.caveat ? [logging.caveat] : []),
      ]} />
    </Section>
  )
}

function ReviewerSection({ reviewers }) {
  return (
    <Section title="Faculty review of alerts" provenance={reviewers.provenance}>
      {reviewers.provenance === 'unavailable' ? <Unavailable reason={reviewers.reason} /> : (
        <>
          <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
            {reviewers.dismissed} of {reviewers.reviewed} reviewed alerts were dismissed ({fmt(reviewers.dismissed_per_hour, 2)} dismissed alerts per monitored hour).
          </p>
          <Table head={['Category', 'Reviewed', 'Confirmed', 'Dismissed', 'Confirmed share']}>
            {reviewers.rows.map(r => (
              <tr key={r.category}>
                <Td>{CATEGORY_LABELS[r.category]}</Td><Td>{r.reviewed}</Td><Td>{r.confirmed}</Td><Td>{r.dismissed}</Td>
                <Td><Prop p={r.confirmed_share} /></Td>
              </tr>
            ))}
          </Table>
          <Caveats items={[reviewers.caveat]} />
        </>
      )}
    </Section>
  )
}

// ── Ground truth management ─────────────────────────────────
function GroundTruthSection({ data, onChange }) {
  const trialBySession = new Map(data.trials.map(t => [t.exam_session_id, t]))
  const intervalsByTrial = data.intervals.reduce((m, g) => m.set(g.trial_id, (m.get(g.trial_id) ?? 0) + 1), new Map())
  const [kind, setKind] = useState('scripted')
  const [msg, setMsg] = useState('')

  async function label(attempt, value) {
    setMsg('')
    const { error } = value === ''
      ? await supabase.from('identity_ground_truth').delete().eq('verification_id', attempt.id)
      : await supabase.from('identity_ground_truth').upsert({
          verification_id: attempt.id, exam_id: attempt.exam_id, is_genuine: value === 'genuine', data_kind: kind,
        }, { onConflict: 'verification_id' })
    if (error) setMsg(error.message); else onChange()
  }

  return (
    <Section title="Ground truth">
      <div className="space-y-6">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">Annotated sessions</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Record when behaviours actually happened, from an independent source (a scripted protocol's log or a consented external recording).
          </p>
          {data.sessions.length ? (
            <Table head={['Student', 'Exam', 'Started', 'Ground truth', '']}>
              {data.sessions.map(s => {
                const t = trialBySession.get(s.id)
                return (
                  <tr key={s.id}>
                    <Td>{s.student?.name ?? '—'} <span className="text-xs text-gray-400">{s.student?.student_id}</span></Td>
                    <Td>{s.exam_title}</Td>
                    <Td>{new Date(s.started_at).toLocaleString()}</Td>
                    <Td>{t ? <span className="inline-flex flex-col gap-1">{KIND_LABELS[t.data_kind]} · {intervalsByTrial.get(t.id) ?? 0} intervals · {t.annotated_categories.length} categories</span>
                           : <span className="text-gray-400">Not annotated</span>}</Td>
                    <Td>
                      <Link to={`/faculty/evaluation/annotate/${s.id}`} className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 hover:underline text-sm">
                        <PencilLine size={13} /> {t ? 'Edit' : 'Annotate'}
                      </Link>
                    </Td>
                  </tr>
                )
              })}
            </Table>
          ) : <p className="text-sm text-gray-500">No exam sessions yet.</p>}
        </div>

        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">Identity verification attempts</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Label an attempt only when you know who was in front of the camera — e.g. a scripted impostor trial with consenting participants.
            Labels apply with the data type chosen here:
            <select value={kind} onChange={e => setKind(e.target.value)} className="ml-2 px-2 py-1 text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800">
              {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </p>
          {msg && <p className="text-xs text-red-600 mb-2">{msg}</p>}
          {data.identity.length ? (
            <Table head={['Student', 'When', 'Result', 'Distance', 'Ground truth']}>
              {data.identity.map(a => (
                <tr key={a.id}>
                  <Td>{a.student?.name ?? '—'}</Td>
                  <Td>{new Date(a.attempted_at).toLocaleString()}</Td>
                  <Td>{a.result.replaceAll('_', ' ')}</Td>
                  <Td>{a.distance == null ? '—' : Number(a.distance).toFixed(3)}</Td>
                  <Td>
                    <select value={a.ground_truth ? (a.ground_truth.is_genuine ? 'genuine' : 'impostor') : ''} onChange={e => label(a, e.target.value)}
                      className="px-2 py-1 text-xs rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800">
                      <option value="">Unlabelled</option>
                      <option value="genuine">Genuine (enrolled student)</option>
                      <option value="impostor">Impostor</option>
                    </select>
                    {a.ground_truth && <span className="ml-2 text-xs text-gray-400">{KIND_LABELS[a.ground_truth.data_kind]}</span>}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : <p className="text-sm text-gray-500">No verification attempts recorded.</p>}
        </div>
      </div>
    </Section>
  )
}


// Exported for render tests.
export {
  DataSummary, AlertsSection, DistributionSection, DetectorSection, IdentitySection,
  RiskSection, ModelSection, LatencySection, ReviewerSection, GroundTruthSection,
}
