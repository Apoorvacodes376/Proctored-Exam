/**
 * ProctoringOverlay.jsx
 * HUD displayed during the exam showing:
 *  - Live monitoring status bar (camera, mic, face, object model)
 *  - Dismissible alert toasts for each proctoring event
 *
 * Designed to be non-intrusive: status bar is compact and fixed to
 * the bottom-right; alerts stack above it.
 */

import { Camera, Mic, MicOff, VideoOff, Eye, EyeOff, Shield, ShieldOff, X, AlertTriangle, Info } from 'lucide-react'

const SEVERITY_STYLES = {
  low:      'bg-blue-50  dark:bg-blue-900/30  border-blue-200  dark:border-blue-800  text-blue-700  dark:text-blue-300',
  medium:   'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300',
  high:     'bg-red-50   dark:bg-red-900/30   border-red-200   dark:border-red-800   text-red-700   dark:text-red-300',
  critical: 'bg-red-100  dark:bg-red-900/50   border-red-300   dark:border-red-700   text-red-800   dark:text-red-200',
}

const SEVERITY_ICON = {
  low:      <Info size={14} strokeWidth={1.75} className="shrink-0 mt-0.5" />,
  medium:   <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0 mt-0.5" />,
  high:     <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0 mt-0.5" />,
  critical: <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0 mt-0.5" />,
}

function StatusDot({ ok, label, OkIcon, BadIcon }) {
  return (
    <span className={`flex items-center gap-1 text-xs font-medium ${ok ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
      {ok ? <OkIcon size={12} strokeWidth={1.75} /> : <BadIcon size={12} strokeWidth={1.75} />}
      {label}
    </span>
  )
}

export default function ProctoringOverlay({ status, onDismiss }) {
  const { cameraOk, micOk, facePresent, objectModel, alerts } = status

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 pointer-events-none">

      {/* Alert toasts — stack above status bar */}
      <div className="flex flex-col gap-2 items-end">
        {alerts.map(alert => (
          <div
            key={alert.id}
            className={`pointer-events-auto flex items-start gap-2 px-3 py-2.5 rounded-xl border text-xs max-w-xs shadow-lg ${SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.medium}`}
          >
            {SEVERITY_ICON[alert.severity]}
            <span className="flex-1 leading-snug">{alert.message}</span>
            <button
              onClick={() => onDismiss(alert.id)}
              className="shrink-0 opacity-60 hover:opacity-100 transition-opacity ml-1"
              aria-label="Dismiss"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>

      {/* Status bar */}
      <div className="pointer-events-auto flex items-center gap-3 px-3 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-md">
        <span className="text-xs text-gray-400 dark:text-gray-500 font-medium mr-1 flex items-center gap-1">
          <Shield size={11} strokeWidth={1.75} /> Monitoring
        </span>

        <StatusDot ok={cameraOk}    label="Cam"  OkIcon={Camera}  BadIcon={VideoOff} />
        <StatusDot ok={micOk}       label="Mic"  OkIcon={Mic}     BadIcon={MicOff}   />
        <StatusDot ok={facePresent} label="Face" OkIcon={Eye}     BadIcon={EyeOff}   />

        {/* Object model status */}
        <span className={`flex items-center gap-1 text-xs font-medium ${
          objectModel === 'ready'       ? 'text-green-600 dark:text-green-400' :
          objectModel === 'unavailable' ? 'text-gray-400 dark:text-gray-500'  :
                                          'text-amber-500 dark:text-amber-400'
        }`}>
          {objectModel === 'ready'       ? <Shield size={12} strokeWidth={1.75} /> :
           objectModel === 'unavailable' ? <ShieldOff size={12} strokeWidth={1.75} /> :
                                           <Shield size={12} strokeWidth={1.75} className="animate-pulse" />}
          {objectModel === 'ready' ? 'AI' : objectModel === 'unavailable' ? 'AI off' : 'AI…'}
        </span>
      </div>
    </div>
  )
}
