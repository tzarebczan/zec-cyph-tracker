// Atomic lock for the cron jobs, backed by a Durable Object.
//
// The previous lock lived in KV and could not be made correct. Acquisition was
// a get-then-put with nothing joining the two, so two ticks could read an
// absent key and both write; the post-write read-back added in #93 only caught
// the interleaving where both writes land before both reads. Order it the
// other way — put(A), read A, put(B), read B — and both ticks see their own
// token under perfectly current reads, no staleness required. A lock needs
// read-and-write to be one indivisible step, and KV has no operation that is.
//
// A Durable Object does. Every request for a given job name routes to one
// object, and `blockConcurrencyWhile` holds off other events for the whole
// read-decide-write, so the check and the claim cannot be split. That also
// makes release exact rather than best-effort: it compares the stored token, so
// a run whose lock already expired and passed to someone else finds a token
// that is not its own and leaves it alone. The margin the KV version needed to
// approximate that is gone.
//
// The job-state record stays in KV — /api/scheduler reads it, it is a debug
// view, and nothing about it needs to be atomic.

/** The one storage key each per-job object keeps. */
const LOCK_KEY = "lock"

type HeldLock = {
  token: string
  expiresAt: number
}

/** The slice of `DurableObjectState` this needs. Declared structurally for the
 *  same reason `KVLike` is: @cloudflare/workers-types collides with the `dom`
 *  lib the Next.js side of this app compiles against. */
interface DurableStateLike {
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
  storage: {
    get<T>(key: string): Promise<T | undefined>
    put<T>(key: string, value: T): Promise<void>
    delete(key: string): Promise<boolean>
  }
}

export class SchedulerLock {
  constructor(private readonly state: DurableStateLike) {}

  /** Take the lock if it is free, returning the token that owns it. The whole
   *  read-decide-write runs inside `blockConcurrencyWhile`, so a second caller
   *  cannot observe the gap between "no lock held" and "lock held". */
  private acquire(ttlMs: number): Promise<string | null> {
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now()
      const held = await this.state.storage.get<HeldLock>(LOCK_KEY)
      // An expired record is not a lock. Treating it as one is what the TTL is
      // for: a run killed by the wall-time limit must not hold this forever.
      if (held && held.expiresAt > now) return null

      const token = `${now}:${crypto.randomUUID()}`
      await this.state.storage.put<HeldLock>(LOCK_KEY, {
        token,
        expiresAt: now + ttlMs,
      })
      return token
    })
  }

  /** Drop the lock, but only if it is still the one this token took. Reports
   *  whether it did, so a caller can tell "released" from "someone else owns
   *  this now" — which on KV was unknowable. */
  private release(token: string): Promise<boolean> {
    return this.state.blockConcurrencyWhile(async () => {
      const held = await this.state.storage.get<HeldLock>(LOCK_KEY)
      if (!held || held.token !== token) return false
      await this.state.storage.delete(LOCK_KEY)
      return true
    })
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    const body = (await request.json().catch(() => ({}))) as {
      ttlMs?: unknown
      token?: unknown
    }

    if (pathname === "/acquire") {
      const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : 0
      if (!(ttlMs > 0)) {
        return Response.json({ error: "ttlMs must be positive" }, { status: 400 })
      }
      return Response.json({ token: await this.acquire(ttlMs) })
    }

    if (pathname === "/release") {
      if (typeof body.token !== "string") {
        return Response.json({ error: "token required" }, { status: 400 })
      }
      return Response.json({ released: await this.release(body.token) })
    }

    return Response.json({ error: "not found" }, { status: 404 })
  }
}

/** Structural view of the `SCHEDULER_LOCK` binding, per the note above. */
export interface LockNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> }
}

/** The URL host is arbitrary — a stub's fetch never leaves the object — but it
 *  has to parse, so give it one that says what it is in a log. */
const LOCK_ORIGIN = "https://scheduler-lock.internal"

function stubFor(ns: LockNamespaceLike, jobName: string) {
  return ns.get(ns.idFromName(jobName))
}

/** Why a tick did not get the lock. The distinction matters: contention is the
 *  lock working, while an unreachable object is the lock being broken, and
 *  reporting both as "locked" would let a dead lock service read as a healthy,
 *  busy scheduler. */
export type LockAttempt =
  | { token: string; reason?: undefined }
  | { token: null; reason: "locked" | "lock-unavailable" }

function stubFetch(
  ns: LockNamespaceLike,
  jobName: string,
  path: string,
  payload: Record<string, unknown>
) {
  return stubFor(ns, jobName).fetch(`${LOCK_ORIGIN}${path}`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function acquireJobLock(
  ns: LockNamespaceLike,
  jobName: string,
  ttlSeconds: number
): Promise<LockAttempt> {
  try {
    const res = await stubFetch(ns, jobName, "/acquire", {
      ttlMs: ttlSeconds * 1000,
    })
    if (!res.ok) return { token: null, reason: "lock-unavailable" }
    const { token } = (await res.json()) as { token: string | null }
    return token ? { token } : { token: null, reason: "locked" }
  } catch {
    // Unreachable object. Refusing to run is the cautious reading — a broken
    // lock costs skipped ticks, where assuming it is free costs overlap.
    return { token: null, reason: "lock-unavailable" }
  }
}

/** Returns whether this token still held the lock. A false means someone else
 *  owns it now, or the object could not be reached; either way the lock is not
 *  ours to free and it will lapse on its own TTL. */
export async function releaseJobLock(
  ns: LockNamespaceLike,
  jobName: string,
  token: string
): Promise<boolean> {
  try {
    const res = await stubFetch(ns, jobName, "/release", { token })
    if (!res.ok) return false
    const { released } = (await res.json()) as { released: boolean }
    return released
  } catch {
    return false
  }
}
