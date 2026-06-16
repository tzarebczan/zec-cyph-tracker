"use client"

const APP_CACHE_PREFIX = "cyphzec-"

export async function clearAppRuntimeCaches(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.()
    await Promise.all((registrations ?? []).map((reg) => reg.unregister()))
  } catch {}

  try {
    if (!("caches" in window)) return
    const keys = await caches.keys()
    await Promise.all(
      keys
        .filter((key) => key.startsWith(APP_CACHE_PREFIX))
        .map((key) => caches.delete(key))
    )
  } catch {}
}

export function removeReloadParam(param: string): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has(param)) return
  url.searchParams.delete(param)
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  )
}

export async function cleanClientReload(
  param = "__app_refresh",
  timeoutMs = 1_500
): Promise<void> {
  const url = new URL(window.location.href)
  url.searchParams.set(param, String(Date.now()))
  await Promise.race([
    clearAppRuntimeCaches(),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ])
  window.location.replace(url.toString())
}
