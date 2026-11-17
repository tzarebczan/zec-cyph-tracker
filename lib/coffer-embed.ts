import { z } from "zod"

export type CofferView = "compact" | "simple" | "full"

const Envelope = z.object({
  protocol: z.literal("zwallet"),
  version: z.literal(1),
  payload: z.discriminatedUnion("type", [
    z.object({ type: z.literal("ready") }),
    z.object({ type: z.literal("result"), id: z.string(), data: z.unknown() }),
    z.object({ type: z.literal("error"), id: z.string(), message: z.string() }),
  ]),
})

/** Presentation-only bridge. No balance, history, identity or spending permissions. */
export function connectCofferFrame({
  iframe,
  url,
  onState,
}: {
  iframe: HTMLIFrameElement
  url: URL
  onState: (state: "ready" | "loading" | "error") => void
}) {
  const frameWindow = iframe.contentWindow
  if (!frameWindow || url.origin === "null") throw new Error("Wallet frame is unavailable.")
  let view: CofferView = "compact"
  let accent = "#34d399"
  let pendingId: string | null = null
  let timeout: ReturnType<typeof setTimeout> | undefined

  const initialize = () => {
    onState("loading")
    clearTimeout(timeout)
    pendingId = crypto.randomUUID()
    frameWindow.postMessage({
      protocol: "zwallet",
      version: 1,
      payload: {
        type: "init",
        id: pendingId,
        config: {
          appId: "cyphzec",
          network: "mainnet",
          authProviders: ["google", "passkey"],
          allowedOrigins: [window.location.origin],
          permissions: [],
          presentation: {
            view,
            appearance: { theme: "cypherpunk", accent },
            brand: { name: "CYPH / ZEC" },
          },
        },
      },
    }, url.origin)
    timeout = setTimeout(() => onState("error"), 30_000)
  }

  const receive = (event: MessageEvent<unknown>) => {
    if (event.source !== frameWindow || event.origin !== url.origin) return
    const parsed = Envelope.safeParse(event.data)
    if (!parsed.success) return
    const message = parsed.data.payload
    if (message.type === "ready") {
      initialize()
    } else if (message.id === pendingId) {
      clearTimeout(timeout)
      pendingId = null
      onState(message.type === "result" ? "ready" : "error")
    }
  }
  window.addEventListener("message", receive)
  iframe.addEventListener("load", initialize)

  return {
    update(nextView: CofferView, nextAccent: string) {
      view = nextView
      accent = /^#[0-9a-f]{6}$/i.test(nextAccent) ? nextAccent : "#34d399"
      initialize()
    },
    destroy() {
      clearTimeout(timeout)
      window.removeEventListener("message", receive)
      iframe.removeEventListener("load", initialize)
    },
  }
}
