/**
 * useProctoring.js
 * Orchestrates all Phase 4 monitoring modules for an active exam session.
 *
 * Responsibilities:
 *  - Acquire camera + microphone stream (reuses stream from VerificationGate
 *    if passed in, otherwise requests a new one).
 *  - Start all monitoring modules once the exam phase begins.
 *  - Route callbacks → eventLogger (Supabase writes).
 *  - Expose live status state for the ProctoringOverlay UI.
 *  - Stop all monitors and release the stream on unmount or exam end.
 *
 * Props:
 *  @param {string}            examSessionId
 *  @param {string}            studentId
 *  @param {boolean}           active          — true only during 'exam' phase
 *  @param {MediaStream|null}  existingStream  — stream from VerificationGate
 *  @param {React.RefObject}   videoRef        — <video> element ref
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { startFaceMonitor }   from '../monitoring/faceMonitor'
import { startObjectMonitor } from '../monitoring/objectMonitor'
import { startAudioMonitor }  from '../monitoring/audioMonitor'
import { startStreamMonitor } from '../monitoring/streamMonitor'
import { startTabMonitor }    from '../monitoring/tabMonitor'
import {
  ensureProctoringSession,
  endProctoringSession,
  logEvent,
  captureAndUploadSnapshot,
  resetCooldowns,
} from '../monitoring/eventLogger'

export function useProctoring({ examSessionId, studentId, active, existingStream, videoRef }) {
  // ── Live status exposed to ProctoringOverlay ──────────────
  const [status, setStatus] = useState({
    cameraOk:      true,
    micOk:         true,
    facePresent:   true,
    objectModel:   'loading',   // 'loading' | 'ready' | 'unavailable'
    alerts:        [],          // [{ id, type, message, severity, ts }]
  })

  const procSessionRef = useRef(null)   // proctoring_sessions.id
  const streamRef      = useRef(null)   // MediaStream
  const stopFns        = useRef([])     // cleanup functions from each module

  // ── Alert helpers ─────────────────────────────────────────
  const addAlert = useCallback((type, message, severity = 'medium') => {
    const alert = { id: `${type}-${Date.now()}`, type, message, severity, ts: Date.now() }
    setStatus(s => ({
      ...s,
      alerts: [alert, ...s.alerts].slice(0, 10),  // keep last 10
    }))
    // Auto-dismiss low/medium alerts after 8 s.
    if (severity === 'low' || severity === 'medium') {
      setTimeout(() => {
        setStatus(s => ({ ...s, alerts: s.alerts.filter(a => a.id !== alert.id) }))
      }, 8_000)
    }
  }, [])

  const dismissAlert = useCallback((id) => {
    setStatus(s => ({ ...s, alerts: s.alerts.filter(a => a.id !== id) }))
  }, [])

  // ── Snapshot helper ───────────────────────────────────────
  async function snapshot() {
    if (!videoRef?.current || !procSessionRef.current) return null
    return captureAndUploadSnapshot(videoRef.current, procSessionRef.current, examSessionId)
  }

  // ── Main effect: start / stop monitoring ─────────────────
  useEffect(() => {
    if (!active || !examSessionId) return

    let cancelled = false

    async function start() {
      resetCooldowns()

      // 1. Acquire stream (reuse existing or request new).
      let stream = existingStream
      if (!stream || stream.getTracks().every(t => t.readyState === 'ended')) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        } catch (err) {
          console.warn('[useProctoring] media access failed:', err.message)
          setStatus(s => ({ ...s, cameraOk: false, micOk: false }))
          return
        }
      }
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
      streamRef.current = stream

      // Attach stream to video element if not already set.
      if (videoRef?.current && !videoRef.current.srcObject) {
        videoRef.current.srcObject = stream
      }

      // 2. Create proctoring_session row.
      let procSession
      try {
        procSession = await ensureProctoringSession(examSessionId, { webcamEnabled: true })
        procSessionRef.current = procSession.id
      } catch (err) {
        console.warn('[useProctoring] could not create proctoring session:', err.message)
        // Continue monitoring even if DB write fails — don't block the student.
      }
      if (cancelled) return

      const psId = procSessionRef.current

      // Helper: log event + optional snapshot.
      async function emit(eventType, severity, confidence, withSnapshot = false, metadata = null) {
        if (!psId) return
        let snapshotId = null
        if (withSnapshot) snapshotId = await snapshot()
        await logEvent(psId, { eventType, severity, confidence, snapshotId, metadata })
      }

      // 3. Face monitor.
      const stopFace = await startFaceMonitor(videoRef?.current, {
        onFaceAbsent: (durationMs) => {
          setStatus(s => ({ ...s, facePresent: false }))
          addAlert('face_not_detected', 'Your face is not visible. Please look at the camera.', 'high')
          emit('face_not_detected', 'high', null, true)
        },
        onFacePresent: () => {
          setStatus(s => ({ ...s, facePresent: true }))
          dismissAlert('face_not_detected')
        },
        onMultipleFaces: (count, confidence) => {
          addAlert('multiple_faces', `${count} people detected in frame.`, 'critical')
          emit('multiple_faces', 'critical', confidence, true, { count })
        },
      }).catch(err => {
        console.warn('[useProctoring] faceMonitor failed to start:', err.message)
        return () => {}
      })
      if (!cancelled) stopFns.current.push(stopFace)

      // 4. Object monitor (loads ONNX model in background).
      const stopObj = await startObjectMonitor(videoRef?.current, {
        onModelReady: () => setStatus(s => ({ ...s, objectModel: 'ready' })),
        onModelError: (err) => {
          console.warn('[useProctoring] object model unavailable:', err.message)
          setStatus(s => ({ ...s, objectModel: 'unavailable' }))
        },
        onObjectDetected: ({ className, confidence }) => {
          addAlert('phone_detected', `Prohibited object detected: ${className}.`, 'critical')
          emit('phone_detected', 'critical', confidence, true, { className })
        },
      }).catch(err => {
        console.warn('[useProctoring] objectMonitor failed to start:', err.message)
        setStatus(s => ({ ...s, objectModel: 'unavailable' }))
        return () => {}
      })
      if (!cancelled) stopFns.current.push(stopObj)

      // 5. Audio monitor.
      const stopAudio = startAudioMonitor(stream, {
        onSpeechDetected: (type) => {
          if (type === 'speech') {
            addAlert('audio_detected', 'Sustained speech detected in your environment.', 'medium')
            emit('audio_detected', 'medium', null, false, { audioType: 'speech' })
          }
          // 'noise' is logged silently without a visible alert.
        },
        onSilence: () => { /* no alert needed */ },
        onMicInterrupted: () => {
          setStatus(s => ({ ...s, micOk: false }))
          addAlert('mic_lost', 'Microphone disconnected or muted.', 'high')
          emit('audio_detected', 'high', null, false, { audioType: 'mic_interrupted' })
        },
        onMicRestored: () => {
          setStatus(s => ({ ...s, micOk: true }))
          dismissAlert('mic_lost')
        },
      })
      if (!cancelled) stopFns.current.push(stopAudio)

      // 6. Stream monitor (camera + mic track health).
      const stopStream = startStreamMonitor(stream, {
        onCameraLost: () => {
          setStatus(s => ({ ...s, cameraOk: false }))
          addAlert('camera_lost', 'Camera stream interrupted. Please check your webcam.', 'critical')
          emit('face_not_detected', 'critical', null, false, { reason: 'camera_lost' })
        },
        onCameraRestored: () => {
          setStatus(s => ({ ...s, cameraOk: true }))
          dismissAlert('camera_lost')
        },
        onMicLost: () => {
          setStatus(s => ({ ...s, micOk: false }))
          addAlert('mic_lost', 'Microphone stream interrupted.', 'high')
        },
        onMicRestored: () => {
          setStatus(s => ({ ...s, micOk: true }))
          dismissAlert('mic_lost')
        },
      })
      if (!cancelled) stopFns.current.push(stopStream)

      // 7. Tab monitor.
      const stopTab = startTabMonitor({
        onTabHidden: (ts) => {
          addAlert('tab_switch', 'You left the exam tab. This has been recorded.', 'high')
          emit('tab_switch', 'high', null, false, { hiddenAt: ts })
        },
        onTabVisible: (durationMs) => {
          dismissAlert('tab_switch')
          if (durationMs > 2_000) {
            // Log return-from-tab as metadata on a second event.
            emit('tab_switch', 'medium', null, false, { returnedAfterMs: durationMs })
          }
        },
        onWindowBlur: (ts) => {
          // Window blur without tab hidden = alt-tab to another app.
          addAlert('tab_switch', 'Exam window lost focus. This has been recorded.', 'medium')
          emit('tab_switch', 'medium', null, false, { blurAt: ts })
        },
        onWindowFocus: () => {
          dismissAlert('tab_switch')
        },
      })
      if (!cancelled) stopFns.current.push(stopTab)
    }

    start()

    return () => {
      cancelled = true
      stopFns.current.forEach(fn => { try { fn?.() } catch {} })
      stopFns.current = []
      if (procSessionRef.current) {
        endProctoringSession(procSessionRef.current).catch(() => {})
        procSessionRef.current = null
      }
      // Don't stop the stream here — ExamRoom owns it.
    }
  }, [active, examSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  return { status, dismissAlert }
}
