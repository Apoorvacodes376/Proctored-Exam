/**
 * liveness.js
 * Challenge-response liveness check used by VerificationGate to make
 * photo and replayed-video attacks harder.
 *
 * The student is asked to perform a short, randomly ordered sequence of
 * actions (blink, turn head left, turn head right). A printed photo or a
 * pre-recorded clip cannot know the sequence in advance. All geometry
 * comes from the 68 face-api landmarks, so the module is pure and unit
 * testable: it takes landmark points, never video.
 *
 * Limits (be honest about these in the paper):
 *  - thresholds below are uncalibrated defaults, not measured values;
 *  - low frame rates can miss a blink (hence the step timeout and retry);
 *  - real-time puppeteering / deepfake face swaps are NOT defended;
 *  - a failed challenge is an indicator for review, never a verdict.
 */

export const STEPS = Object.freeze({
  BLINK: 'blink',
  TURN_LEFT: 'turn_left',   // the student's own left
  TURN_RIGHT: 'turn_right', // the student's own right
})

export const LIVENESS_CONFIG = Object.freeze({
  challengeLength: 3,
  stepTimeoutMs: 8000,
  earClosed: 0.20,   // eye aspect ratio below this = eye closed
  earOpen: 0.25,     // above this = eye open
  yawTurn: 0.14,     // |yaw| beyond this = head turned (yaw is 0 when facing the camera)
  yawFacing: 0.08,   // |yaw| within this = facing the camera
  sampleIntervalMs: 100, // pause between landmark samples in the browser loop
  holdSamples: 2,    // consecutive samples a turn must be held
})

export const STEP_PROMPTS = Object.freeze({
  [STEPS.BLINK]: 'Blink once',
  [STEPS.TURN_LEFT]: 'Turn your head to your left',
  [STEPS.TURN_RIGHT]: 'Turn your head to your right',
})

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

function ear(p) { // p: six points in the standard 68-landmark eye order
  const horizontal = dist(p[0], p[3])
  if (horizontal === 0) return 0
  return (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * horizontal)
}

/** Mean eye aspect ratio of both eyes from 68 landmark points. */
export function eyeAspectRatio(points) {
  if (!points || points.length < 48) throw new Error('need 68 landmark points')
  return (ear(points.slice(36, 42)) + ear(points.slice(42, 48))) / 2
}

/**
 * Horizontal head rotation from the nose tip's position between the jaw
 * end points. 0 = facing the camera; positive = the student's LEFT
 * (camera image is not mirrored); negative = their right.
 */
export function estimateYaw(points) {
  if (!points || points.length < 31) throw new Error('need 68 landmark points')
  const left = points[0], right = points[16], nose = points[30]
  const width = right.x - left.x
  if (width <= 0) return 0
  return (nose.x - left.x) / width - 0.5
}

/** A random sequence of steps with no step repeated back to back. */
export function createChallenge(rng = Math.random, length = LIVENESS_CONFIG.challengeLength) {
  const all = Object.values(STEPS)
  const out = []
  while (out.length < length) {
    // Draw from the steps other than the previous one, so there is no
    // back-to-back repeat and the loop always terminates.
    const pool = out.length ? all.filter(s => s !== out[out.length - 1]) : all
    out.push(pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))])
  }
  return out
}

/**
 * Tracks progress through a challenge.
 *   const s = createLivenessSession(steps)
 *   s.update({ ear, yaw } | null, nowMs) -> { status, index, prompt }
 * status: 'pending' | 'passed' | 'failed'. Each step has its own timeout;
 * a sample of null means no face was found in that frame.
 */
export function createLivenessSession(steps, config = LIVENESS_CONFIG) {
  let index = 0
  let stepStart = null
  let sawOpen = false, sawClosed = false
  let held = 0
  let status = 'pending'
  let failedStep = null

  const snapshot = () => ({
    status,
    index,
    step: steps[index] ?? null,
    prompt: status === 'pending' ? STEP_PROMPTS[steps[index]] : null,
    failedStep,
  })
  function nextStep(now) {
    index += 1
    stepStart = now
    sawOpen = sawClosed = false
    held = 0
    if (index >= steps.length) status = 'passed'
  }

  return {
    steps,
    update(sample, now) {
      if (status !== 'pending') return snapshot()
      if (stepStart === null) stepStart = now
      const step = steps[index]

      if (sample) {
        if (step === STEPS.BLINK) {
          if (sample.ear >= config.earOpen) {
            if (sawClosed && sawOpen) { nextStep(now); return snapshot() }
            sawOpen = true
          } else if (sample.ear <= config.earClosed && sawOpen) {
            sawClosed = true
          }
        } else {
          const want = step === STEPS.TURN_LEFT ? sample.yaw >= config.yawTurn : sample.yaw <= -config.yawTurn
          held = want ? held + 1 : 0
          if (held >= config.holdSamples) { nextStep(now); return snapshot() }
        }
      }

      if (now - stepStart > config.stepTimeoutMs) {
        status = 'failed'
        failedStep = step
      }
      return snapshot()
    },
  }
}

/**
 * Combine the identity distances measured before and after the challenge.
 * The larger one is used, so swapping the person mid-challenge cannot pass.
 */
export function worstDistance(before, after) {
  return Math.max(before, after)
}
