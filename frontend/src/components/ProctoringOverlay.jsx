/**
 * ProctoringOverlay.jsx
 * Shown throughout the exam so the student always knows monitoring is on:
 *  - "Monitoring active" header with a live self-view of the webcam
 *  - Per-module status (camera, mic, face, objects, audio, logging)
 *  - Alert toasts for each proctoring event, with actions where useful
 *  - "What is monitored?" panel stating what is and is not detected
 *
 * Non-intrusive: fixed bottom-right, collapsible.
 */

import { useState } from 'react'
import {
  Camera, VideoOff, Mic, MicOff, Eye, EyeOff, ScanSearch, AudioLines, CloudUpload, CloudOff,
  X, AlertTriangle, Info, ChevronDown, ChevronUp, HelpCircle,
} from 'lucide-react'

const SEVERITY_STYLES = {
  low:      'bg-blue-50  dark:bg-blue-900/30  border-blue-200  dark:border-blue-800  text-blue-700  dark:text-blue-300',
  medium:   'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300',
  high:     'bg-red-50   dark:bg-red-900/30   border-red-200   dark:border-red-800   text-red-700   dark:text-red-300',
  critical: 'bg-red-100  dark:bg-red-900/50   border-red-300   dark:border-red-700   text-red-800   dark:text-red-200',
}

const TONE = {
  ok:   'text-green-600 dark:text-green-400',
  warn: 'text-amber-500 dark:text-amber-400',
  bad:  'text-red-500 dark:text-red-400',
  off:  'text-gray-400 dark:text-gray-500',
}

function Item({ tone, Icon, label, title }) {
  return (
    <span title={title} className={`flex items-center gap-1 text-xs font-medium ${TONE[tone]}`}>
      <Icon size={12} strokeWidth={1.75} className={tone === 'warn' ? 'animate-pulse' : ''} />
      {label}
    </span>
  )
}

function statusItems(s) {
  const camLost = s.camera === 'lost'
  const micLost = s.microphone === 'lost'
  return [
    s.camera === 'lost'
      ? { tone: 'bad',  Icon: VideoOff, label: 'Cam',  title: 'Camera interrupted' }
      : { tone: s.camera === 'ok' ? 'ok' : 'warn', Icon: Camera, label: 'Cam', title: 'Camera' },
    s.microphone === 'lost'
      ? { tone: 'bad',  Icon: MicOff, label: 'Mic', title: 'Microphone interrupted' }
      : { tone: s.microphone === 'ok' ? 'ok' : 'warn', Icon: Mic, label: 'Mic', title: 'Microphone' },
    camLost || s.face === 'unavailable'
      ? { tone: 'off', Icon: EyeOff, label: 'Face', title: 'Face check unavailable' }
      : s.face === 'absent'
        ? { tone: 'bad',  Icon: EyeOff, label: 'Face', title: 'Face not visible' }
        : { tone: s.face === 'loading' ? 'warn' : 'ok', Icon: Eye, label: 'Face', title: s.face === 'loading' ? 'Loading face model…' : 'Face visible' },
    camLost || s.objects === 'unavailable'
      ? { tone: 'off', Icon: ScanSearch, label: 'Objects', title: 'Object detection unavailable' }
      : { tone: s.objects === 'active' ? 'ok' : 'warn', Icon: ScanSearch, label: 'Objects', title: s.objects === 'active' ? 'Object detection on' : 'Loading object model…' },
    micLost || s.audio === 'unavailable'
      ? { tone: 'off', Icon: AudioLines, label: 'Audio', title: 'Audio analysis unavailable' }
      : { tone: s.audio === 'running' ? 'ok' : 'warn', Icon: AudioLines, label: 'Audio', title: s.audio === 'suspended' ? 'Paused — click the page' : 'Audio analysis on' },
    s.logging === 'error' || s.logging === 'retrying'
      ? { tone: s.logging === 'error' ? 'bad' : 'warn', Icon: CloudOff, label: 'Log', title: s.logging === 'error' ? 'Events cannot be saved' : 'Reconnecting — events are queued' }
      : { tone: s.logging === 'ok' ? 'ok' : 'warn', Icon: CloudUpload, label: 'Log', title: 'Events are being saved' },
  ]
}

function MonitoringInfo() {
  return (
    <div className="pointer-events-auto w-80 max-h-[60vh] overflow-y-auto p-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg text-xs text-gray-600 dark:text-gray-300 space-y-2">
      <p className="font-semibold text-gray-900 dark:text-white">What is monitored during this exam</p>
      <ul className="list-disc pl-4 space-y-1">
        <li>Whether your face is visible to the webcam, and whether more than one person appears.</li>
        <li>Phones and books visible to the webcam (AI object detection).</li>
        <li>Sustained speech and loud noises picked up by your microphone. Audio is analysed on your device and is not recorded.</li>
        <li>Whether your camera or microphone stops working or is disabled.</li>
        <li>Leaving this tab or switching to another window.</li>
      </ul>
      <p>
        When an alert happens, a single webcam snapshot may be saved as evidence. Only your faculty can view it.
        Alerts are reviewed by a person and are not an automatic verdict.
      </p>
      <p className="font-semibold text-gray-900 dark:text-white pt-1">What it cannot do</p>
      <p>
        A browser cannot see other devices, other applications, second screens, or anything outside the camera's view.
        It cannot tell whose voice it hears. Detection can miss things or raise false alarms.
      </p>
    </div>
  )
}

export default function ProctoringOverlay({ status, onDismiss, videoRef }) {
  const [collapsed, setCollapsed] = useState(false)
  const [showInfo, setShowInfo]   = useState(false)
  const items = statusItems(status)

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 pointer-events-none max-w-[calc(100vw-2rem)]">

      {/* Alerts */}
      <div className="flex flex-col gap-2 items-end" role="status" aria-live="polite">
        {status.alerts.map(alert => (
          <div key={alert.id}
            className={`pointer-events-auto flex items-start gap-2 px-3 py-2.5 rounded-xl border text-xs max-w-xs shadow-lg ${SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.medium}`}>
            {alert.severity === 'low'
              ? <Info size={14} strokeWidth={1.75} className="shrink-0 mt-0.5" />
              : <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0 mt-0.5" />}
            <div className="flex-1 leading-snug space-y-1.5">
              <p>{alert.message}</p>
              {alert.action && (
                <button onClick={alert.action.run}
                  className="px-2 py-1 rounded-md bg-white/70 dark:bg-black/20 border border-current font-semibold hover:opacity-80">
                  {alert.action.label}
                </button>
              )}
            </div>
            <button onClick={() => onDismiss(alert.id)} aria-label="Dismiss"
              className="shrink-0 opacity-60 hover:opacity-100 transition-opacity ml-1">
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>

      {showInfo && <MonitoringInfo />}

      {/* Monitoring panel */}
      <div className="pointer-events-auto bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-md overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
          </span>
          <span className="text-xs font-semibold text-gray-800 dark:text-gray-100">Monitoring active</span>
          <button onClick={() => setShowInfo(v => !v)} aria-label="What is monitored?" title="What is monitored?"
            className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <HelpCircle size={14} strokeWidth={1.75} />
          </button>
          <button onClick={() => setCollapsed(v => !v)} aria-label={collapsed ? 'Expand' : 'Collapse'}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>

        {/* The video element stays mounted and laid out (monitors read frames from it);
            collapsing clips it rather than using display:none. */}
        <div className="px-3 space-y-2 overflow-hidden" style={collapsed ? { height: 0 } : { paddingBottom: '0.5rem' }}>
          <video ref={videoRef} autoPlay muted playsInline aria-label="Your webcam"
            className="w-56 aspect-video rounded-lg bg-gray-900 object-cover -scale-x-100" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 w-56">
            {items.map(it => <Item key={it.label} {...it} />)}
          </div>
        </div>
      </div>
    </div>
  )
}
