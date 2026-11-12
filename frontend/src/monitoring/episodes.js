/**
 * episodes.js
 * Small pure helpers used by useProctoring to turn monitor callbacks into
 * "one event per continuous episode".
 *
 * createEpisodes(logger)  open(key, event) logs once while the key is open;
 *                         close(key) records when it ended.
 * createHitWindow(n, k)   debounces a per-scan boolean: 'start' after k
 *                         hits in the last n scans, 'end' after n misses.
 */

/**
 * @param {{ log: Function, close: Function }} logger  see eventLogger.js
 * @param {object} [hooks]
 * @param {function} [hooks.onError]  (err) => void — logging failures never throw to callers
 */
export function createEpisodes(logger, { onError } = {}) {
  const open = new Map()     // key → { startedAt, idPromise }

  return {
    isOpen: key => open.has(key),

    /** Log `event` unless an episode with this key is already open. Returns true if opened. */
    open(key, event) {
      if (open.has(key)) return false
      const idPromise = Promise.resolve()
        .then(() => logger.log(event))
        .then(rec => rec?.id ?? null, err => { onError?.(err); return null })
      open.set(key, { startedAt: Date.now(), idPromise })
      return true
    },

    /** Close the episode. Returns its duration in ms, or null if none was open. */
    close(key, endedAt = Date.now()) {
      const ep = open.get(key)
      if (!ep) return null
      open.delete(key)
      ep.idPromise
        .then(id => id && logger.close(id, endedAt))
        .catch(err => onError?.(err))
      return endedAt - ep.startedAt
    },

    /** Close everything (exam ending). */
    closeAll(endedAt = Date.now()) {
      for (const key of [...open.keys()]) this.close(key, endedAt)
    },
  }
}

export function createHitWindow(size = 3, minHits = 2) {
  const hist = []
  let active = false
  return {
    update(hit) {
      hist.push(!!hit)
      if (hist.length > size) hist.shift()
      const hits = hist.filter(Boolean).length
      if (!active && hit && hits >= minHits) { active = true;  return 'start' }
      if (active && hits === 0)              { active = false; return 'end' }
      return null
    },
    get active() { return active },
  }
}
