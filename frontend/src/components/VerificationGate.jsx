import { useEffect, useRef, useState, useCallback } from 'react'
import * as faceapi from '@vladmandic/face-api'
import { Camera, Loader2, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Mic, MicOff, VideoOff } from 'lucide-react'

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model'
// Euclidean distance threshold for FaceNet 128-d embeddings.
// < 0.50 → same person (generous for lighting variation)
// > 0.65 → different person
const MATCH_THRESHOLD = 0.52

let modelsLoaded = false

async function ensureModels() {
  if (modelsLoaded) return
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ])
  modelsLoaded = true
}

async function getEmbedding(imageEl) {
  const detection = await faceapi
    .detectSingleFace(imageEl, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor()
  return detection?.descriptor ?? null
}

function euclidean(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2
  return Math.sqrt(sum)
}

// ── States ──────────────────────────────────────────────────
// idle → loading_models → requesting_media → ready
// → capturing → verifying → passed | failed | manual_review
// ────────────────────────────────────────────────────────────

export default function VerificationGate({ referencePhotoUrl, onVerified, onManualReview }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState('')
  const [distance, setDistance] = useState(null)
  const [micOk, setMicOk] = useState(null)
  const [camOk, setCamOk] = useState(null)

  // Load models + start camera on mount
  useEffect(() => {
    let cancelled = false
    async function init() {
      setPhase('loading_models')
      try {
        await ensureModels()
      } catch {
        if (!cancelled) setError('Failed to load face recognition models. Check your internet connection.')
        return
      }
      if (cancelled) return
      setPhase('requesting_media')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream

        // Check tracks
        const videoTrack = stream.getVideoTracks()[0]
        const audioTrack = stream.getAudioTracks()[0]
        setCamOk(!!videoTrack && videoTrack.readyState === 'live')
        setMicOk(!!audioTrack && audioTrack.readyState === 'live')
        setPhase('ready')
      } catch (err) {
        if (!cancelled) {
          if (err.name === 'NotAllowedError') setError('Camera and microphone access was denied. Please allow permissions and try again.')
          else if (err.name === 'NotFoundError') setError('No camera or microphone found. Please connect a device and try again.')
          else setError(`Media error: ${err.message}`)
          setPhase('idle')
        }
      }
    }
    init()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  const capture = useCallback(async () => {
    setError('')
    setPhase('capturing')

    // Draw current video frame to an offscreen canvas
    const video = videoRef.current
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)

    setPhase('verifying')

    try {
      // Get embedding from live capture
      const liveEmbed = await getEmbedding(canvas)
      if (!liveEmbed) {
        setError('No face detected in the webcam image. Ensure your face is clearly visible and well-lit.')
        setPhase('ready')
        return
      }

      // Load reference photo and get its embedding
      const refImg = new Image()
      refImg.crossOrigin = 'anonymous'
      await new Promise((res, rej) => {
        refImg.onload = res
        refImg.onerror = () => rej(new Error('Could not load reference photo.'))
        refImg.src = referencePhotoUrl
      })
      const refEmbed = await getEmbedding(refImg)
      if (!refEmbed) {
        // Reference photo has no detectable face — allow manual review
        setPhase('manual_review')
        return
      }

      const dist = euclidean(liveEmbed, refEmbed)
      setDistance(dist)

      if (dist <= MATCH_THRESHOLD) {
        setPhase('passed')
      } else if (dist <= 0.70) {
        // Borderline — offer manual review
        setPhase('manual_review')
      } else {
        setPhase('failed')
      }
    } catch (err) {
      setError(err.message || 'Verification error.')
      setPhase('ready')
    }
  }, [referencePhotoUrl])

  function retry() {
    setError('')
    setDistance(null)
    setPhase('ready')
  }

  // ── Render ─────────────────────────────────────────────────

  if (phase === 'passed') {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
          <CheckCircle2 size={36} strokeWidth={1.5} className="text-green-600 dark:text-green-400" />
        </div>
        <p className="text-lg font-semibold text-gray-900 dark:text-white">Identity Verified</p>
        <p className="text-sm text-gray-500 dark:text-gray-400">Match confidence: {((1 - distance) * 100).toFixed(1)}%</p>
        <button
          onClick={() => { streamRef.current?.getTracks().forEach(t => t.stop()); onVerified() }}
          className="mt-2 px-6 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-xl transition-colors"
        >
          Continue to Exam
        </button>
      </div>
    )
  }

  if (phase === 'failed') {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
          <XCircle size={36} strokeWidth={1.5} className="text-red-500" />
        </div>
        <p className="text-lg font-semibold text-gray-900 dark:text-white">Verification Failed</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-xs">
          Your face did not match the reference photograph. Ensure you are in good lighting and facing the camera directly.
        </p>
        <div className="flex gap-3 mt-2">
          <button onClick={retry} className="flex items-center gap-2 px-4 py-2 text-sm font-medium border border-gray-300 dark:border-gray-700 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <RefreshCw size={14} strokeWidth={1.75} /> Try Again
          </button>
          <button onClick={() => { streamRef.current?.getTracks().forEach(t => t.stop()); onManualReview() }}
            className="px-4 py-2 text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-xl transition-colors">
            Request Manual Review
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'manual_review') {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
          <AlertTriangle size={36} strokeWidth={1.5} className="text-amber-600 dark:text-amber-400" />
        </div>
        <p className="text-lg font-semibold text-gray-900 dark:text-white">Low Confidence Match</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-xs">
          Automatic verification was inconclusive. You can retry in better lighting or request manual review by your faculty.
        </p>
        <div className="flex gap-3 mt-2">
          <button onClick={retry} className="flex items-center gap-2 px-4 py-2 text-sm font-medium border border-gray-300 dark:border-gray-700 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <RefreshCw size={14} strokeWidth={1.75} /> Retry
          </button>
          <button onClick={() => { streamRef.current?.getTracks().forEach(t => t.stop()); onManualReview() }}
            className="px-4 py-2 text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-xl transition-colors">
            Request Manual Review
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Device status */}
      {(camOk !== null || micOk !== null) && (
        <div className="flex items-center gap-4 text-xs">
          <span className={`flex items-center gap-1.5 ${camOk ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
            {camOk ? <Camera size={13} strokeWidth={1.75} /> : <VideoOff size={13} strokeWidth={1.75} />}
            Camera {camOk ? 'ready' : 'not detected'}
          </span>
          <span className={`flex items-center gap-1.5 ${micOk ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
            {micOk ? <Mic size={13} strokeWidth={1.75} /> : <MicOff size={13} strokeWidth={1.75} />}
            Microphone {micOk ? 'ready' : 'not detected'}
          </span>
        </div>
      )}

      {/* Live video preview */}
      <div className="relative rounded-2xl overflow-hidden bg-black aspect-video w-full max-w-sm mx-auto">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover"
        />
        {(phase === 'loading_models' || phase === 'requesting_media' || phase === 'capturing' || phase === 'verifying') && (
          <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-2">
            <Loader2 size={28} strokeWidth={1.75} className="text-white animate-spin" />
            <p className="text-white text-xs">
              {phase === 'loading_models' && 'Loading face recognition models…'}
              {phase === 'requesting_media' && 'Requesting camera access…'}
              {phase === 'capturing' && 'Capturing image…'}
              {phase === 'verifying' && 'Verifying identity…'}
            </p>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400">
          <XCircle size={15} strokeWidth={1.75} className="shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
        Position your face in the centre of the frame, ensure good lighting, then click Verify.
      </p>

      <button
        onClick={capture}
        disabled={phase !== 'ready'}
        className="w-full flex items-center justify-center gap-2 py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors"
      >
        {phase === 'ready' ? (
          <><Camera size={16} strokeWidth={1.75} /> Verify My Identity</>
        ) : (
          <><Loader2 size={16} strokeWidth={1.75} className="animate-spin" /> Please wait…</>
        )}
      </button>
    </div>
  )
}
