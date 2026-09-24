import { E_PALETTES } from "@/components/palettes"
import {
  APPEARANCE_DEFAULTS,
  BACKGROUNDS,
  DENSITIES,
  FONT_SIZE_SCALE,
  MOTIONS,
  SETTINGS_STORAGE_KEY,
} from "@/components/settings-schema"

/**
 * Inline script for the document head that paints the user's appearance
 * settings onto `<html>` before the first frame.
 *
 * `useCyphzecSettings` does the same work in an effect after hydration,
 * which is fine for a first-time visitor (defaults in, defaults out) but a
 * returning user with a larger font or tighter density saw the whole page
 * lay out at the defaults and then re-flow two seconds in: a 0.15 layout
 * shift on its own, measured on a phone. Applying the same attributes and
 * variables synchronously in the head makes the mount-time pass a no-op.
 *
 * The script must stay self-contained (no imports, no React) and tolerant
 * of missing or malformed storage; every branch falls back to the default
 * the hook would use. Keep it in sync with `applySettings`.
 */
export function settingsHeadScript(): string {
  const cfg = JSON.stringify({
    key: SETTINGS_STORAGE_KEY,
    defaults: APPEARANCE_DEFAULTS,
    palettes: E_PALETTES,
    fontScale: FONT_SIZE_SCALE,
    densities: DENSITIES,
    backgrounds: BACKGROUNDS,
    motions: MOTIONS,
  })
  return `(function(){try{var c=${cfg},d=c.defaults,r=document.documentElement,s=null;try{s=JSON.parse(localStorage.getItem(c.key)||"null")}catch(e){}if(!s||typeof s!=="object")s={};var pick=function(v,ok,f){return ok.indexOf(v)>=0?v:f};var density=pick(s.density,c.densities,d.density),font=Object.prototype.hasOwnProperty.call(c.fontScale,s.fontSize)?s.fontSize:d.fontSize,motion=pick(s.motion,c.motions,d.motion),bg=pick(s.background,c.backgrounds,d.background),vignette=typeof s.vignette==="boolean"?s.vignette:d.vignette,glow=typeof s.glow==="number"&&isFinite(s.glow)?Math.max(0,Math.min(100,s.glow)):d.glow,pal=c.palettes[s.palette]||c.palettes[d.palette];r.dataset.czTheme="on";r.dataset.czDensity=density;r.dataset.czFont=font;r.dataset.czMotion=motion;r.dataset.czBg=bg;r.dataset.czVignette=vignette?"on":"off";var st=r.style;st.setProperty("--cz-glow",String(glow/100));st.setProperty("--cz-font-scale",String(c.fontScale[font]));for(var k in pal)if(Object.prototype.hasOwnProperty.call(pal,k))st.setProperty("--cz-"+k,pal[k])}catch(e){}})();`
}
