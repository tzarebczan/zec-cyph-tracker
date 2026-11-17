// Runs before every production deploy. beta.cyphzec.com belongs to the separate
// zec-cyph-tracker-beta Worker (wrangler.beta.jsonc). A custom domain moves to whichever
// Worker deploys it last, so listing it here would silently take the beta site over.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

/** Drops // and block comments outside strings, then trailing commas. */
function parseJsonc(text) {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      const start = i
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++
      out += text.slice(start, i + 1)
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1
      assert(i > 0, "Unclosed block comment in wrangler.jsonc")
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

const config = parseJsonc(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"))
assert.equal(config.name, "zec-cyph-tracker")
assert.deepEqual(
  config.routes,
  [
    { pattern: "cyphzec.com", custom_domain: true },
    { pattern: "cyphzec.jiggytom.com", custom_domain: true },
  ],
  "Production must bind only cyphzec.com and cyphzec.jiggytom.com. beta.cyphzec.com is deployed by the beta Worker (pnpm cf:deploy:beta).",
)
console.log("Production deploy binds cyphzec.com and cyphzec.jiggytom.com only; beta.cyphzec.com stays with the beta Worker.")
