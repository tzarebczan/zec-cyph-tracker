// Device-local launcher state. Only the launcher's place on screen and
// whether the wallet was ever opened here are stored; nothing from Coffer.

export type LauncherSide = "left" | "right"
/** `x` and `y` run from 0 at the leftmost and highest allowed spot to 1 at the
 *  rightmost and lowest, so a saved place survives rotation and window
 *  resizes. `folded` shrinks the launcher to the Coffer mark. */
export type LauncherPosition = { x: number; y: number; folded?: boolean }

const unit = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 1

const POSITION_KEY = "cyphzec.walletLauncher.position.v1"
const OPENED_KEY = "cyphzec.walletLauncher.opened.v1"
const RESET_EVENT = "cyphzec:wallet-launcher-reset"

export function readLauncherPosition(): LauncherPosition | null {
  try {
    const value = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null")
    // Places saved before free placement kept only the screen side.
    const x = unit(value?.x) ? value.x : value?.side === "left" ? 0 : value?.side === "right" ? 1 : null
    if (x !== null && unit(value?.y)) return value.folded === true ? { x, y: value.y, folded: true } : { x, y: value.y }
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
