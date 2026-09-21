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

async function call<T>(
  ns: LockNamespaceLike,
  jobName: string,
  path: string,
  payload: Record<string, unknown>,
  fallback: T
): Promise<T> {
  try {
    const res = await stubFor(ns, jobName).fetch(`${LOCK_ORIGIN}${path}`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    // The object is unreachable. Every caller's fallback is the cautious
    // reading — no lock acquired, nothing released — so a broken lock service
    // costs skipped ticks rather than overlapping runs.
    return fallback
  }
}

export async function acquireJobLock(
  ns: LockNamespaceLike,
  jobName: string,
  ttlSeconds: number
): Promise<string | null> {
  const { token } = await call<{ token: string | null }>(
    ns,
    jobName,
    "/acquire",
    { ttlMs: ttlSeconds * 1000 },
    { token: null }
  )
  return token
}

export async function releaseJobLock(
  ns: LockNamespaceLike,
  jobName: string,
  token: string
): Promise<boolean> {
  const { released } = await call<{ released: boolean }>(
    ns,
    jobName,
    "/release",
    { token },
    { released: false }
  )
  return released
}
