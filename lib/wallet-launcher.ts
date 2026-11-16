// Device-local launcher state. Only the launcher's place on screen and
// whether the wallet was ever opened here are stored; nothing from Coffer.

export type LauncherSide = "left" | "right"
/** `y` is 0 at the highest allowed spot and 1 at the lowest, so a saved
 *  place survives rotation and window resizes. */
export type LauncherPosition = { side: LauncherSide; y: number }

const POSITION_KEY = "cyphzec.walletLauncher.position.v1"
const OPENED_KEY = "cyphzec.walletLauncher.opened.v1"
const RESET_EVENT = "cyphzec:wallet-launcher-reset"

export function readLauncherPosition(): LauncherPosition | null {
  try {
    const value = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null")
    if ((value?.side === "left" || value?.side === "right") && typeof value.y === "number" && value.y >= 0 && value.y <= 1) {
      return { side: value.side, y: value.y }
    }
  } catch {}
  return null
}

export function saveLauncherPosition(position: LauncherPosition) {
  try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)) } catch {}
}

export function resetLauncherPosition() {
  try { localStorage.removeItem(POSITION_KEY) } catch {}
  window.dispatchEvent(new Event(RESET_EVENT))
}

export function onLauncherReset(listener: () => void) {
  window.addEventListener(RESET_EVENT, listener)
  return () => window.removeEventListener(RESET_EVENT, listener)
}

export function markWalletOpened() {
  try { localStorage.setItem(OPENED_KEY, "1") } catch {}
}

export function walletOpenedHere() {
  try { return localStorage.getItem(OPENED_KEY) === "1" } catch { return false }
}
