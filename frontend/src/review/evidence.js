/**
 * evidence.js
 * Resolves an evidence snapshot id to a short-lived signed URL for the
 * private proctoring-frames bucket. Only the exam's faculty can resolve
 * snapshots (RLS on proctoring_snapshots and storage.objects).
 *
 * The client is injected so this is testable without Supabase.
 */

export const EVIDENCE_BUCKET = 'proctoring-frames'

/**
 * @param {object} client     Supabase client
 * @param {object} [opts]
 * @param {number} [opts.ttlS]  signed URL lifetime
 * @param {function} [opts.now]
 */
export function createEvidenceResolver(client, { ttlS = 300, now = () => Date.now() } = {}) {
  const cache = new Map()   // snapshotId → { url, path, capturedAt, expiresAt } | Promise

  async function resolve(snapshotId) {
    const { data: snap, error } = await client
      .from('proctoring_snapshots')
      .select('storage_path, captured_at')
      .eq('id', snapshotId)
      .maybeSingle()
    if (error) return { error: error.message }
    if (!snap) return { error: 'Snapshot not found or not accessible.' }

    const { data, error: signErr } = await client.storage
      .from(EVIDENCE_BUCKET)
      .createSignedUrl(snap.storage_path, ttlS)
    if (signErr || !data?.signedUrl) return { error: signErr?.message ?? 'Could not create a link to the image.' }

    return {
      url: data.signedUrl,
      path: snap.storage_path,
      capturedAt: snap.captured_at,
      // refresh a little before the link actually expires
      expiresAt: now() + (ttlS - 30) * 1000,
    }
  }

  return {
    /** @returns {Promise<{url, path, capturedAt} | {error}>} */
    async get(snapshotId) {
      if (!snapshotId) return { error: 'No snapshot for this event.' }
      const hit = cache.get(snapshotId)
      if (hit instanceof Promise) return hit
      if (hit && hit.expiresAt > now()) return hit
      const p = resolve(snapshotId).then(r => {
        if (r.error) cache.delete(snapshotId)
        else cache.set(snapshotId, r)
        return r
      })
      cache.set(snapshotId, p)
      return p
    },
  }
}
