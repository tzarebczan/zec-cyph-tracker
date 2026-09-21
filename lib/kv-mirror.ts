// Write-rate control for best-effort KV mirrors.
//
// Most routes here keep two KV entries for the same payload: a TTL'd "fresh"
// entry that gates upstream refetching, and an untimed "stale" mirror that
// exists so a total upstream outage still has something to serve. The fresh
// entry has to be written on every refresh — that is what makes it fresh. The
// mirror does not: it is a disaster fallback, already labelled stale wherever
// it is served, and nobody can tell whether it is thirty seconds or ten
// minutes behind. Writing it on every refresh doubled this account's KV write
// volume for no user-visible gain, and KV bills writes, not bytes.
//
// The same argument covers any "last known good" entry read only on a cold
// isolate: /api/quote rewrote a 7-day-TTL mirror every 30 seconds, per
// isolate, so a warm colo alone spent ~2,900 writes a day on an entry that is
// read once at startup.
//
// Throttling is per isolate, in module scope. That is deliberately weaker
// than a global lock: isolates are cheap and numerous, and a few extra writes
// after a cold start cost nothing next to a write every refresh forever. It
// also cannot be wrong in the dangerous direction — a mirror that is written
// too rarely still holds real data, just older.

/** Last write time per key, for this isolate only. */
const lastWriteAt = new Map<string, number>()

/** Default spacing for a disaster-fallback mirror. Far longer than any
 *  route's refresh cadence, far shorter than the outages it exists for. */
export const MIRROR_MIN_INTERVAL_MS = 10 * 60_000

/** Whether this isolate should write `key` now, recording the attempt when it
 *  says yes. Call it immediately before the put — a caller that skips the
 *  write after a `true` simply delays the next one by one interval. */
export function shouldWriteMirror(
  key: string,
  minIntervalMs: number = MIRROR_MIN_INTERVAL_MS,
  now: number = Date.now()
): boolean {
  const prev = lastWriteAt.get(key)
  if (prev != null && now - prev < minIntervalMs) return false
  lastWriteAt.set(key, now)
  return true
}

/** `kv.put` for a mirror, skipped when this isolate wrote it recently.
 *  Never throws: mirrors are best-effort by construction. */
export async function putMirror(
  kv: { put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> } | null,
  key: string,
  value: string,
  options?: { expirationTtl?: number; minIntervalMs?: number }
): Promise<void> {
  if (!kv) return
  if (!shouldWriteMirror(key, options?.minIntervalMs)) return
  try {
    await kv.put(
      key,
      value,
      options?.expirationTtl != null
        ? { expirationTtl: options.expirationTtl }
        : undefined
    )
  } catch {
    /* best-effort */
  }
}

/** Test seam: forget this isolate's write history. */
export function resetMirrorThrottleForTests(): void {
  lastWriteAt.clear()
}
