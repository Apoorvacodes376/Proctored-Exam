/**
 * useProctoring.js
 * Orchestrates the Phase 4 monitoring modules for an active exam session.
 *
 *  - Starts tab/focus monitoring immediately (needs no camera or model).
 *  - Acquires camera + microphone (reuses the stream from VerificationGate
 *    when it is still live) and starts stream-status and audio monitors.
 *  - Loads the face and object models in the background — nothing waits
 *    on a model download.
 *  - Turns monitor callbacks into one logged event per continuous episode,
 *    with webcam evidence at alert points, and notifies the student.
 *  - Exposes `reconnect()` to re-acquire a camera/mic whose track ended.
 *
 *  - Records per-module processing time and reports one summary per
 *    minute to monitoring_performance (Phase 6 evaluation).
 *
 * All detection logic lives in src/monitoring/* and is tested there.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { startFaceMonitor }   from '../monitoring/faceMonitor'
import { startObjectMonitor } from '../monitoring/objectMonitor'
import { startAudioMonitor }  from '../monitoring/audioMonitor'
import { startStreamMonitor } from '../monitoring/streamMonitor'
import { startTabMonitor }    from '../monitoring/tabMonitor'
import { createEventLogger, captureVideoFrame } from '../monitoring/eventLogger'
import { createEpisodes, createHitWindow } from '../monitoring/episodes'
import { createHeartbeat } from '../monitoring/heartbeat'
import { createLatencyRecorder, deviceInfo } from '../monitoring/latency'

const FLUSH_MS     = 15_000
const AUTO_DISMISS = 8_000

const FACE_GRACE_MS = Number(import.meta.env.VITE_FACE_GRACE_MS) || 8_000

const REASON_TEXT = {
  missing:            'is not available — access was not granted or no device was found',
  ended:              'stopped — it may have been unplugged, disabled or taken by another app',
  muted:              'is not sending any signal (muted or covered)',
  permission_revoked: 'permission was withdrawn in the browser',
}

const INITIAL_STATUS = {
  active:     false,
  camera:     'pending',    // 'pending' | 'ok' | 'lost'
  microphone: 'pending',
  face:       'loading',    // 'loading' | 'present' | 'absent' | 'unavailable'
  objects:    'loading',    // 'loading' | 'active' | 'unavailable'
  audio:      'loading',    // 'loading' | 'running' | 'suspended' | 'unavailable'
  logging:    'connecting', // 'connecting' | 'ok' | 'retrying' | 'error'
  away:       false,        // exam tab hidden / window unfocused
  alerts:     [],           // [{ id, message, severity, action? }]
}

function healthy(track) {
  return !!track && track.readyState === 'live' && !track.muted
}

function secs(ms) {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`
}

export function useProctoring({ examSessionId, examId, studentId, active, existingStream, videoRef }) {
  const [status, setStatus] = useState(INITIAL_STATUS)
  const patch = useCallback(p => setStatus(s => ({ ...s, ...p })), [])

  const reconnectRef = useRef(null)
  const timers = useRef(new Set())

  // ── Student notifications ─────────────────────────────────
  // Alerts are keyed so a persistent condition shows one alert, which is
  // replaced/removed as the condition changes.
  const dismissAlert = useCallback(id => {
    setStatus(s => ({ ...s, alerts: s.alerts.filter(a => a.id !== id) }))
  }, [])

  const notify = useCallback((id, message, severity = 'medium', { persist = false, action = null } = {}) => {
    setStatus(s => ({
      ...s,
      alerts: [{ id, message, severity, action }, ...s.alerts.filter(a => a.id !== id)].slice(0, 6),
    }))
    if (!persist) {
      const t = setTimeout(() => { timers.current.delete(t); dismissAlert(id) }, AUTO_DISMISS)
      timers.current.add(t)
    }
  }, [dismissAlert])

  // ── Main lifecycle ────────────────────────────────────────
  useEffect(() => {
    if (!active || !examSessionId) return

    let cancelled = false
    const pendingTimers = timers.current
    const stops = []
    let streamStops = []
    let ownedStream = null
    let currentStream = null

    const video  = () => videoRef?.current ?? null
    const logger = createEventLogger({
      client: supabase,
      examSessionId,
      studentId,
      examId,
      captureFrame: () => captureVideoFrame(video()),
    })

    // Events raised before the session row exists wait for it.
    const ready = logger.start().then(
      () => { if (!cancelled) patch({ logging: 'ok' }) },
      err => {
        console.warn('[useProctoring] cannot create proctoring session:', err.message)
        if (!cancelled) patch({ logging: 'error' })
        throw err
      },
    )
    ready.catch(() => {})

    const gatedLogger = {
      log:   async e => { await ready; return logger.log(e) },
      close: async (id, at) => { await ready; return logger.close(id, at) },
    }
    const episodes = createEpisodes(gatedLogger, {
      onError: err => console.warn('[useProctoring] event not logged:', err.message),
    })
    const once = e => gatedLogger.log(e).catch(err => console.warn('[useProctoring] event not logged:', err.message))

    // Processing-latency measurements (device-dependent; see monitoring/latency.js).
    const device = deviceInfo()
    const latency = createLatencyRecorder({
      onFlush: rows => {
        supabase.from('monitoring_performance')
          .insert(rows.map(r => ({ ...r, exam_session_id: examSessionId, device })))
          .then(({ error }) => { if (error) console.warn('[useProctoring] latency not recorded:', error.message) })
      },
    })
    latency.start()

    patch({ ...INITIAL_STATUS, active: true, alerts: [] })

    // ── 6. Tab / focus — first, so nothing delays it ──
    stops.push(startTabMonitor({
      onLeave: ({ reason, at }) => {
        patch({ away: true })
        episodes.open('away', {
          eventType: reason === 'tab_hidden' ? 'tab_switch' : 'focus_lost',
          occurredAt: at,
          metadata: { reason },
        })
      },
      onReturn: ({ reason, awayMs, at }) => {
        patch({ away: false })
        episodes.close('away', at)
        notify('away',
          reason === 'tab_hidden'
            ? `You left the exam tab for ${secs(awayMs)}. This has been recorded.`
            : `The exam window lost focus for ${secs(awayMs)}. This has been recorded.`,
          reason === 'tab_hidden' ? 'high' : 'medium')
      },
    }))

    // ── 5. Camera / microphone status ──
    const kindInfo = {
      camera:     { key: 'camera', eventType: 'camera_interrupted', label: 'Camera' },
      microphone: { key: 'mic',    eventType: 'mic_interrupted',    label: 'Microphone' },
    }
    let mediaError = null

    function onLost(kind, reason) {
      const k = kindInfo[kind]
      patch({ [kind]: 'lost' })
      episodes.open(k.key, {
        eventType: k.eventType,
        metadata: { reason, ...(mediaError && { error: mediaError }) },
      })
      notify(k.key, `${k.label} ${REASON_TEXT[reason] ?? 'was interrupted'}. Monitoring needs it — please reconnect.`,
        kind === 'camera' ? 'high' : 'medium',
        { persist: true, action: { label: 'Reconnect', run: () => reconnectRef.current?.() } })
    }

    function onRestored(kind) {
      const k = kindInfo[kind]
      patch({ [kind]: 'ok' })
      if (episodes.close(k.key) !== null) {
        dismissAlert(k.key)
        notify(`${k.key}-ok`, `${k.label} reconnected.`, 'low')
      }
    }

    // ── 4. Audio ──
    function startAudio(stream) {
      return startAudioMonitor(stream, {
        onStateChange: state => {
          patch({ audio: state })
          if (state === 'suspended') {
            notify('audio-paused', 'Audio monitoring is paused by the browser. Click anywhere on the page to resume it.', 'low', { persist: true })
          } else {
            dismissAlert('audio-paused')
          }
        },
        onSpeechStart: ({ confidence }) => {
          if (episodes.open('speech', { eventType: 'speech_detected', confidence, metadata: { audio_class: 'speech' } })) {
            notify('speech', 'Speech was detected near you. Please keep your exam environment quiet.', 'medium')
          }
        },
        onSpeechEnd: () => episodes.close('speech'),
        onNoiseStart: ({ peakDb, aboveFloorDb }) => {
          if (episodes.open('noise', { eventType: 'unusual_noise', metadata: { audio_class: 'noise', peak_dbfs: peakDb, above_floor_db: aboveFloorDb } })) {
            notify('noise', 'A loud noise was detected.', 'low')
          }
        },
        onNoiseEnd: () => episodes.close('noise'),
        onTiming: ms => latency.record('audio', ms),
      })
    }

    function startStreamDependent(stream) {
      streamStops.forEach(fn => fn())
      streamStops = [
        startStreamMonitor(stream, { onLost, onRestored }),
        startAudio(stream),
      ]
      // A healthy new track ends any interruption carried over from before.
      if (healthy(stream.getVideoTracks()[0])) onRestored('camera')
      if (healthy(stream.getAudioTracks()[0])) onRestored('microphone')
    }

    async function acquire() {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        mediaError = null
        return s
      } catch (err) {
        mediaError = err.name
        // Try each device on its own so one missing device doesn't cost both.
        const parts = await Promise.all([
          navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null),
          navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null),
        ])
        const tracks = parts.flatMap(p => p?.getTracks() ?? [])
        return tracks.length ? new MediaStream(tracks) : null
      }
    }

    function attach(stream) {
      currentStream = stream
      const v = video()
      if (v && v.srcObject !== stream) v.srcObject = stream
    }

    reconnectRef.current = async () => {
      const s = await acquire()
      if (cancelled) { s?.getTracks().forEach(t => t.stop()); return }
      if (!s) { notify('reconnect', 'Could not access the camera or microphone. Check your browser permissions.', 'high'); return }
      if (ownedStream && ownedStream !== s) ownedStream.getTracks().forEach(t => t.stop())
      ownedStream = s
      attach(s)
      startStreamDependent(s)
    }

    async function startMedia() {
      let stream = existingStream
      if (!stream || !stream.getTracks().some(t => t.readyState === 'live')) {
        stream = await acquire()
        if (cancelled) { stream?.getTracks().forEach(t => t.stop()); return }
        ownedStream = stream
      }
      const empty = { getVideoTracks: () => [], getAudioTracks: () => [], getTracks: () => [] }
      if (stream) attach(stream)
      startStreamDependent(stream ?? empty)
      if (!stream) {
        patch({ face: 'unavailable', objects: 'unavailable', audio: 'unavailable' })
        return
      }

      // ── 1 & 2. Face presence / multiple people ──
      const people = { faces: false, persons: false }
      function updatePeople(source, on, detail) {
        people[source] = on
        if (on) {
          if (episodes.open('people', {
            eventType: 'multiple_faces',
            confidence: detail.confidence,
            evidence: true,
            metadata: { source, count: detail.count },
          })) notify('people', 'More than one person appears to be in view. This has been recorded.', 'critical')
        } else if (!people.faces && !people.persons) {
          episodes.close('people')
          dismissAlert('people')
        }
      }

      stops.push(startFaceMonitor(video(), {
        onReady: () => patch({ face: 'present' }),
        onError: err => { console.warn('[useProctoring] face model unavailable:', err.message); patch({ face: 'unavailable' }) },
        onFaceAbsent: ({ since }) => {
          patch({ face: 'absent' })
          // A dead camera explains the missing face; it is logged once, as such.
          if (!healthy(currentStream?.getVideoTracks()[0])) return
          episodes.open('face', { eventType: 'face_not_detected', occurredAt: since, evidence: true, metadata: { grace_ms: FACE_GRACE_MS } })
          notify('face', "We can't see your face. Please make sure you are in front of the camera.", 'high', { persist: true })
        },
        onFacePresent: () => {
          patch({ face: 'present' })
          episodes.close('face')
          dismissAlert('face')
        },
        onMultipleFaces: ({ count, confidence }) => updatePeople('faces', true, { count, confidence }),
        onSingleFace:    () => updatePeople('faces', false),
        onTiming:        ms => latency.record('face', ms),
      }, { gracePeriodMs: FACE_GRACE_MS }))

      // ── 3. Objects (+ person count as a second multi-person signal) ──
      const personWindow = createHitWindow(3, 2)
      stops.push(startObjectMonitor(video(), {
        onReady: () => patch({ objects: 'active' }),
        onError: err => { console.warn('[useProctoring] object model unavailable:', err.message); patch({ objects: 'unavailable' }) },
        onObjectDetected: ({ classId, className, confidence, bbox }) => {
          const isPhone = className === 'cell phone'
          once({
            eventType: isPhone ? 'phone_detected' : 'object_detected',
            confidence,
            evidence: true,
            dedupeKey: `object:${classId}`,
            metadata: { class_name: className, coco_class: classId, bbox: bbox && Object.fromEntries(Object.entries(bbox).map(([k, v]) => [k, Math.round(v)])) },
          }).then(rec => {
            if (rec) notify(`object-${classId}`, `A ${className} was detected in view. This has been recorded.`, isPhone ? 'critical' : 'high')
          })
        },
        onPersons: ({ count, confidence }) => {
          const edge = personWindow.update(count > 1)
          if (edge === 'start') updatePeople('persons', true, { count, confidence })
          if (edge === 'end')   updatePeople('persons', false)
        },
        onTiming: ms => latency.record('objects', ms),
      }))
    }

    startMedia()

    const flushId = setInterval(() => {
      logger.flush().then(ok => { if (!cancelled) patch({ logging: ok ? 'ok' : 'retrying' }) }, () => {})
    }, FLUSH_MS)

    return () => {
      cancelled = true
      clearInterval(flushId)
      pendingTimers.forEach(clearTimeout)
      pendingTimers.clear()
      stops.forEach(fn => { try { fn() } catch { /* already stopped */ } })
      streamStops.forEach(fn => { try { fn() } catch { /* already stopped */ } })
      episodes.closeAll()
      latency.stop()   // reports the last partial window
      ready.then(() => logger.end()).catch(() => {})
      ownedStream?.getTracks().forEach(t => t.stop())   // ExamRoom owns existingStream
      reconnectRef.current = null
      patch({ active: false })
    }
  }, [active, examSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live status for the faculty dashboard (Phase 5) ───────
  const heartbeatRef = useRef(null)

  useEffect(() => {
    if (!active || !examSessionId) return
    const hb = createHeartbeat({
      send: async fields => {
        const { error } = await supabase.rpc('report_live_status', { p_exam_session_id: examSessionId, p_status: fields })
        if (error) throw error
      },
      onError: err => console.warn('[useProctoring] heartbeat failed:', err.message),
    })
    heartbeatRef.current = hb
    return () => { hb.stop(); heartbeatRef.current = null }
  }, [active, examSessionId])

  useEffect(() => {
    if (status.active) heartbeatRef.current?.update(status)
  }, [status])

  const reconnect = useCallback(() => reconnectRef.current?.(), [])

  return { status, dismissAlert, reconnect }
}
