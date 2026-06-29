// SafeLight Red Eye Correction extension.
//
// A dedicated, heal-style red-eye tool. Each correction is a feathered disc that
// the GPU neutralizes (kills the red glow, preserves the white catchlight) and
// darkens to a natural pupil. Corrections are stored as the correction stage's
// uniform values in the per-photo param bag, so they:
//   - render live, undo/redo with the normal edit history, and
//   - bake into exports automatically (the export renderer rebuilds from the
//     same param bag) — without consuming the app's 8-mask budget.
//
// Three coordinated contributions: a GPU processing stage, an interactive
// canvas overlay (rings + live cursor + click/drag placement), and a panel that
// mirrors the built-in Heal tool's UX.
//
// No bundled dependencies: React, components, and stores come from the
// SafelightAPI. This file IS the prebuilt ESM bundle (manifest "main").

const EXT_ID = "redeye";
const STAGE_ID = "redeye.correct";
const MAX_SPOTS = 8; // dedicated budget; does NOT touch the app's mask limit
const TOOL_HINT = "Click an eye · drag to size";

const KGEO = (i) => `${STAGE_ID}.uReGeo${i}`; // vec4 [cx, cy, radius, radius] (image-UV; radius in image-height units, aspect-corrected in the shader)
const KPAR = (i) => `${STAGE_ID}.uRePar${i}`; // vec4 [feather, desat, darken, enabled] (0..1)
const KCOUNT = `${STAGE_ID}.uReCount`;

let unregisterStage = null; // set in activate, called from deactivate
let unsubTool = null; // store subscription teardown

// ---------------------------------------------------------------------------
// Settings (edited via the ⚙ dialog in the Extensions panel)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  sensitivity: 60, // 0..100, higher = more aggressive detection
  minPupil: 0.3, // min pupil radius, % of image height
  maxPupil: 4, // max pupil radius, % of image height
  maxDetections: 6, // cap per "Auto-detect all" run (≤ MAX_SPOTS)
  analyzeEdge: "1200", // analysis resolution (long edge, px)
  size: 2, // default correction radius, % of image height
  feather: 40, // default edge feather, %
  desat: 90, // default desaturation, %
  darken: 55, // default darkening, %
  autoCommit: true, // write a history snapshot after auto-detect
};

const SETTINGS_FIELDS = [
  { key: "sensitivity", label: "Detection sensitivity", type: "number", default: DEFAULTS.sensitivity, min: 0, max: 100, step: 1, hint: "Higher finds fainter red eyes but risks false positives" },
  { key: "minPupil", label: "Min pupil size (% of height)", type: "number", default: DEFAULTS.minPupil, min: 0.05, max: 10, step: 0.05 },
  { key: "maxPupil", label: "Max pupil size (% of height)", type: "number", default: DEFAULTS.maxPupil, min: 0.5, max: 20, step: 0.5 },
  { key: "maxDetections", label: "Max detections per run", type: "number", default: DEFAULTS.maxDetections, min: 1, max: MAX_SPOTS, step: 1 },
  { key: "size", label: "Default size (% of height)", type: "number", default: DEFAULTS.size, min: 0.2, max: 10, step: 0.1, hint: "Radius of a fresh correction before you drag/auto-size" },
  { key: "feather", label: "Default feather (%)", type: "number", default: DEFAULTS.feather, min: 0, max: 100, step: 5 },
  { key: "desat", label: "Default desaturation (%)", type: "number", default: DEFAULTS.desat, min: 0, max: 100, step: 5 },
  { key: "darken", label: "Default darken (%)", type: "number", default: DEFAULTS.darken, min: 0, max: 100, step: 5 },
  {
    key: "analyzeEdge", label: "Analysis resolution", type: "select", default: DEFAULTS.analyzeEdge,
    options: [
      { value: "800", label: "Fast (800 px)" },
      { value: "1200", label: "Balanced (1200 px)" },
      { value: "1600", label: "Accurate (1600 px)" },
    ],
    hint: "Long edge the photo is downscaled to before scanning",
  },
  { key: "autoCommit", label: "Add history step after detect", type: "boolean", default: DEFAULTS.autoCommit },
];

// ---------------------------------------------------------------------------
// GPU correction stage
// ---------------------------------------------------------------------------

// reSpot: inside a feathered disc, neutralize the red channel toward the
// green/blue average, desaturate, and darken — weighted by how red the pixel
// actually is, so the white catchlight and surrounding skin survive.
// reApply: 8 unrolled spot applications (no array uniforms in the GLSL path).
function buildStage() {
  let calls = "";
  for (let i = 0; i < MAX_SPOTS; i++) {
    calls += `  c = reSpot(c, uv, uReGeo${i}, uRePar${i});\n`;
  }
  const helpers = `vec3 reSpot(vec3 c, vec2 uv, vec4 geo, vec4 par) {
  if (par.w < 0.5) return c;            // disabled slot
  float radius = geo.w;                 // pupil radius, image-height units
  if (radius <= 0.0) return c;          // empty slot
  // Aspect-correct the x axis with the true decoded-buffer aspect (uImageAspect,
  // a core uniform) so the disc is a real circle on screen at any orientation —
  // the same convention the built-in heal/mask tools use. (Baking per-axis radii
  // from catalog photo.width/height skewed it into an ellipse on
  // orientation-divergent decodes, e.g. rotated RAWs.)
  vec2 d = vec2((uv.x - geo.x) * uImageAspect, uv.y - geo.y) / radius;
  float dist = length(d);
  if (dist > 1.0) return c;
  float feather = clamp(par.x, 0.0, 1.0);
  float inner = 1.0 - feather;          // hard core radius (in normalized units)
  float w = 1.0 - smoothstep(inner, 1.0, dist);
  if (w <= 0.0) return c;
  float redness = c.r - max(c.g, c.b);  // >0 only where red dominates
  float redMask = smoothstep(0.04, 0.18, redness);
  float eff = w * redMask;
  if (eff <= 0.0) return c;             // skip catchlight / neutral pixels
  float gray = (c.g + c.b) * 0.5;
  vec3 fixedCol = c;
  fixedCol.r = min(c.r, gray);          // kill the red glow
  float L = dot(fixedCol, vec3(0.299, 0.587, 0.114));
  fixedCol = mix(fixedCol, vec3(L), clamp(par.y, 0.0, 1.0)); // desaturate
  fixedCol *= (1.0 - clamp(par.z, 0.0, 1.0) * 0.85);         // darken
  return mix(c, fixedCol, eff);
}

vec3 reApply(vec3 c, vec2 uv) {
${calls}  return c;
}`;

  const uniforms = [{ key: "uReCount", glslType: "int", default: 0, label: "Corrections" }];
  for (let i = 0; i < MAX_SPOTS; i++) {
    uniforms.push({ key: `uReGeo${i}`, glslType: "vec4", default: [0, 0, 0, 0] });
    uniforms.push({ key: `uRePar${i}`, glslType: "vec4", default: [0, 0, 0, 0] });
  }

  return {
    id: STAGE_ID,
    name: "Red Eye Correction",
    phase: "effects",
    priority: 40, // before vignette/grain; operates on display-referred color
    // srcUv is the source-anchored UV (after crop/transform/lens) that masks and
    // retouch use — NOT vUv, which spans only the visible window when zoomed. Using
    // srcUv keeps the correction locked to the eye at any zoom / crop / rotation.
    glsl: "c = reApply(c, srcUv);",
    helpers,
    uniforms,
  };
}

// ---------------------------------------------------------------------------
// Detection: redness score -> hysteresis mask -> connected components ->
// hole-fill -> shape/skin filters -> confidence ranking
// ---------------------------------------------------------------------------

/** Loose skin-tone test on a raw RGB triple: red leads, green follows, and the
 *  channel spread is in a plausible range. Used to confirm a red blob is framed
 *  by skin (an eye) rather than sitting on red cloth / a logo / a brake light. */
function isSkin(r, g, b) {
  return r > 80 && r > g && g >= b && r - b > 15 && r - b < 170 && r - g < 90;
}

/**
 * Scan RGBA pixels for compact, strongly red, skin-framed blobs (red eyes).
 * Returns up to maxCount blobs as { cx, cy, radius, weight } in *pixels* of the
 * analyzed image, ranked by confidence, overlaps deduplicated.
 *
 * Pipeline: a per-pixel redness score gates pixels at two thresholds
 * (hysteresis) — strong pixels seed blobs, weaker ones let a blob grow out to
 * the full pupil rim. Each blob's central catchlight (a bright near-neutral
 * glint that isn't "red") is folded back in so the disc reads as solid. Blobs
 * are then filtered by size/roundness, scored by mean redness × roundness ×
 * how much skin surrounds them, and bonused when they pair up like real eyes.
 */
function detectRedEyes(data, w, h, opts) {
  const n = w * h;
  // Seed (high) threshold scales with sensitivity; the grow (low) threshold sits
  // a fixed fraction below it so a blob captures its whole rim without leaking.
  const thrHigh = 2.2 - (opts.sensitivity / 100) * 1.4;
  const thrLow = thrHigh * 0.55;

  const score = new Float32Array(n);
  // 0 none · 1 weak red · 2 strong-red seed · 3 catchlight glint · 9 claimed
  const state = new Uint8Array(n);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const mx = g > b ? g : b;
    // Require red to clearly lead the brighter of g/b: this gates out bright
    // neutral and orange/yellow pixels that the ratio alone would pass.
    if (r >= 60 && r - mx >= 18) {
      const s = (r * r) / (g * g + b * b + 1400);
      if (s > thrLow) {
        score[i] = s;
        state[i] = s > thrHigh ? 2 : 1;
      }
    } else if (r > 170 && g > 170 && b > 170) {
      state[i] = 3; // bright near-neutral -> candidate catchlight
    }
  }

  const minR = (opts.minPupil / 100) * h;
  const maxR = (opts.maxPupil / 100) * h;
  const stack = new Int32Array(n);
  const raw = [];

  for (let seed = 0; seed < n; seed++) {
    if (state[seed] !== 2) continue; // only strong pixels seed a blob
    let top = 0;
    stack[top++] = seed;
    state[seed] = 9;
    let area = 0, sx = 0, sy = 0, weight = 0;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    while (top > 0) {
      const q = stack[--top];
      const x = q % w;
      const y = (q / w) | 0;
      area++;
      sx += x;
      sy += y;
      weight += score[q];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      let j;
      if (x > 0)     { j = q - 1; if (state[j] === 1 || state[j] === 2) { state[j] = 9; stack[top++] = j; } }
      if (x < w - 1) { j = q + 1; if (state[j] === 1 || state[j] === 2) { state[j] = 9; stack[top++] = j; } }
      if (y > 0)     { j = q - w; if (state[j] === 1 || state[j] === 2) { state[j] = 9; stack[top++] = j; } }
      if (y < h - 1) { j = q + w; if (state[j] === 1 || state[j] === 2) { state[j] = 9; stack[top++] = j; } }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    // Fold the central catchlight back in: bright glint pixels inside the box are
    // part of the eye but aren't red, so the raw area underestimates the pupil.
    let glint = 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX, idx = y * w + minX; x <= maxX; x++, idx++) {
        if (state[idx] === 3) glint++;
      }
    }
    const filled = area + glint;
    const radius = Math.sqrt(filled / Math.PI);
    if (radius < minR || radius > maxR) continue;
    const aspect = bw / bh;
    if (aspect < 0.55 || aspect > 1.8) continue; // pupils read roughly round
    const fill = filled / (bw * bh);
    if (fill < 0.45) continue;                   // and roughly disc-shaped
    raw.push({ cx: sx / area, cy: sy / area, radius, area, weight, fill });
  }

  // Skin-surround: sample a ring just outside each blob; a real eye is mostly
  // framed by skin, a red object usually isn't.
  const TWO_PI = Math.PI * 2;
  for (const bl of raw) {
    const rr = bl.radius * 1.8;
    let skin = 0, samples = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TWO_PI;
      const x = Math.round(bl.cx + Math.cos(a) * rr);
      const y = Math.round(bl.cy + Math.sin(a) * rr);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const p = (y * w + x) * 4;
      samples++;
      if (isSkin(data[p], data[p + 1], data[p + 2])) skin++;
    }
    bl.skinFrac = samples ? skin / samples : 0;
    // Confidence: average redness, lifted by roundness and skin framing.
    bl.conf = (bl.weight / bl.area) * (0.5 + 0.5 * bl.fill) * (0.4 + 0.6 * bl.skinFrac);
  }

  // Pair bonus: eyes come two-to-a-face — similar size, roughly level, a few
  // diameters apart. A blob with such a partner is far likelier to be an eye.
  for (const a of raw) {
    for (const b of raw) {
      if (a === b) continue;
      const rAvg = (a.radius + b.radius) / 2;
      const dx = Math.abs(a.cx - b.cx);
      const dy = Math.abs(a.cy - b.cy);
      const sizeOk = Math.min(a.radius, b.radius) / Math.max(a.radius, b.radius) > 0.5;
      if (sizeOk && dy < rAvg * 3 && dx > rAvg * 1.5 && dx < rAvg * 25) { a.conf *= 1.5; break; }
    }
  }

  raw.sort((a, b) => b.conf - a.conf);
  const out = [];
  for (const b of raw) {
    if (out.length >= opts.maxCount) break;
    if (out.some((o) => Math.hypot(o.cx - b.cx, o.cy - b.cy) < (o.radius + b.radius) * 0.8)) continue;
    out.push({ cx: b.cx, cy: b.cy, radius: b.radius, weight: b.conf });
  }
  return out;
}

/** Decode the photo the same way the app does (no EXIF re-orientation, so
 *  coordinates line up with the image-UV space). RAW falls back to the
 *  thumbnail — UV coordinates are scale-invariant, so that still works. */
async function loadBitmap(photo) {
  if (photo.fileHandle) {
    try {
      const file = await photo.fileHandle.getFile();
      return await createImageBitmap(file, { imageOrientation: "none" });
    } catch {
      /* RAW or unreadable -> thumbnail */
    }
  }
  if (photo.thumbnailBlob) {
    try {
      return await createImageBitmap(photo.thumbnailBlob, { imageOrientation: "none" });
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Downscale to the analysis resolution and return ImageData. */
function readPixels(bitmap, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(api) {
  const { react: React, stores, components } = api;
  const { useDevelopStore, useCatalogStore, create } = stores;
  const { Panel, Slider } = components;
  const h = React.createElement;

  const S = (key) => api.settings.get(key, DEFAULTS[key]);
  const dev = () => useDevelopStore.getState();

  api.registerSettings({ fields: SETTINGS_FIELDS });
  api.registerProcessingStage(buildStage());
  unregisterStage = () => api.unregisterProcessingStage?.(STAGE_ID);

  // Tool state shared by the panel and the canvas overlay. Cursor position is
  // kept in overlay-local React state (high-frequency) so the panel never
  // re-renders on mouse move.
  const useTool = create((set) => ({
    active: false,
    selected: null, // selected slot index, or null
    setActive: (active) => set((s) => ({ active, selected: active ? s.selected : null })),
    select: (selected) => set({ selected }),
  }));

  // Red Eye and the core tools (mask / heal / HSL picker) are mutually exclusive.
  // If another tool takes over (activeTool leaves "none"), drop out of correction
  // mode so our overlay stops capturing pointer events — otherwise it would sit on
  // top of the canvas and block the active tool *and* pan/zoom.
  unsubTool = useDevelopStore.subscribe((s) => {
    if (s.activeTool !== "none" && useTool.getState().active) {
      useTool.getState().setActive(false);
    }
  });

  // --- spot read/write over the per-photo param bag -----------------------

  function readSpots(bag) {
    const out = [];
    for (let i = 0; i < MAX_SPOTS; i++) {
      const geo = bag[KGEO(i)];
      if (!Array.isArray(geo) || !(geo[2] > 0) || !(geo[3] > 0)) continue;
      const par = bag[KPAR(i)];
      out.push({
        slot: i,
        cx: geo[0], cy: geo[1], rx: geo[2], ry: geo[3],
        feather: Array.isArray(par) ? par[0] : 0.4,
        desat: Array.isArray(par) ? par[1] : 0.9,
        darken: Array.isArray(par) ? par[2] : 0.55,
        enabled: Array.isArray(par) ? par[3] >= 0.5 : true,
      });
    }
    return out;
  }

  const countPresent = (bag) => {
    let c = 0;
    for (let i = 0; i < MAX_SPOTS; i++) {
      const g = bag[KGEO(i)];
      if (Array.isArray(g) && g[2] > 0 && g[3] > 0) c++;
    }
    return c;
  };

  const nextFreeSlot = (bag) => {
    for (let i = 0; i < MAX_SPOTS; i++) {
      const g = bag[KGEO(i)];
      if (!Array.isArray(g) || !(g[2] > 0)) return i;
    }
    return -1;
  };

  // Coalesce high-frequency drag writes to one store update per animation frame
  // so a fast gesture doesn't flood the render worker.
  let rafPatch = null;
  let rafId = 0;
  function liveSet(patch) {
    rafPatch = Object.assign(rafPatch || {}, patch);
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const p = rafPatch;
        rafPatch = null;
        if (p) dev().setDynParams(p);
      });
    }
  }
  function flushLive() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (rafPatch) { dev().setDynParams(rafPatch); rafPatch = null; }
  }

  function applySpot(slot, geo, par, live) {
    const bag = dev().paramBag;
    const merged = { ...bag };
    const patch = {};
    if (geo) { patch[KGEO(slot)] = geo; merged[KGEO(slot)] = geo; }
    if (par) { patch[KPAR(slot)] = par; merged[KPAR(slot)] = par; }
    patch[KCOUNT] = countPresent(merged);
    if (live) liveSet(patch);
    else dev().setDynParams(patch);
  }

  function removeSpot(slot) {
    const bag = dev().paramBag;
    const merged = { ...bag, [KGEO(slot)]: [0, 0, 0, 0], [KPAR(slot)]: [0, 0, 0, 0] };
    dev().setDynParams({ [KGEO(slot)]: [0, 0, 0, 0], [KPAR(slot)]: [0, 0, 0, 0], [KCOUNT]: countPresent(merged) });
  }

  const commit = () => void dev().commitEdit("Red eye");
  const defaultPar = () => [S("feather") / 100, S("desat") / 100, S("darken") / 100, 1];

  // --- detection cache (shared by Auto-detect and click-to-place) ---------

  let analysis = { sig: null, imgW: 0, imgH: 0, blobs: [] };

  function analysisSig() {
    return `${dev().photoId}|${S("sensitivity")}|${S("minPupil")}|${S("maxPupil")}|${S("analyzeEdge")}`;
  }

  async function ensureAnalysis() {
    const sig = analysisSig();
    if (analysis.sig === sig) return analysis;
    const photo = useCatalogStore.getState().photos.find((p) => p.id === dev().photoId);
    if (!photo) return null;
    const bmp = await loadBitmap(photo);
    if (!bmp) return null;
    let img;
    try {
      img = readPixels(bmp, parseInt(S("analyzeEdge"), 10) || 1200);
    } finally {
      bmp.close?.();
    }
    const blobs = detectRedEyes(img.data, img.width, img.height, {
      sensitivity: S("sensitivity"), minPupil: S("minPupil"), maxPupil: S("maxPupil"), maxCount: 64,
    });
    analysis = { sig, imgW: img.width, imgH: img.height, blobs };
    return analysis;
  }

  /** Blob (analysis px) -> geo vec4 [cx, cy, radius, radius] in image-UV. The
   *  radius is in image-height units (the shader aspect-corrects via uImageAspect),
   *  so both slots carry the same value. */
  function blobToGeo(b) {
    const pad = 1.25; // cover the pupil plus a little of the iris edge
    const r = (b.radius * pad) / analysis.imgH;
    return [b.cx / analysis.imgW, b.cy / analysis.imgH, r, r];
  }

  // --- canvas overlay -----------------------------------------------------

  function Overlay() {
    // imageRect + mapping helpers map source-UV <-> screen accounting for
    // zoom/pan/crop/straighten — the same mapping the built-in Heal overlay uses.
    const { imageRect, toScreen, toImage, radiusToScreen, radiusToImage } = api.develop.useDevelopOverlay();
    const paramBag = useDevelopStore((s) => s.paramBag);
    const active = useTool((s) => s.active);
    const selected = useTool((s) => s.selected);
    const photoId = useDevelopStore((s) => s.photoId);
    const [cursor, setCursor] = React.useState(null); // {x,y} frame px
    // While a pan/zoom gesture key (Space or Ctrl/⌘) is held, turn the overlay
    // click-through so the viewport beneath handles pan/zoom — same modifier the
    // built-in Heal tool uses. Keeps pan/zoom live and the marks glued to the image.
    const [passthrough, setPassthrough] = React.useState(false);
    const drag = React.useRef(null);

    // Prefetch detection so a click can auto-size synchronously.
    React.useEffect(() => {
      if (active) void ensureAnalysis();
    }, [active, photoId]);

    React.useEffect(() => {
      if (!active) { setPassthrough(false); return; }
      let space = false, mod = false;
      const sync = () => setPassthrough(space || mod);
      const down = (e) => {
        if (e.key === "Escape" || e.code === "Escape") {
          // Finish correcting. Consume it so nothing else also acts on Esc.
          e.preventDefault();
          e.stopPropagation();
          space = false; mod = false; sync();
          useTool.getState().setActive(false);
          return;
        }
        if (e.code === "Space") space = true;
        if (e.key === "Control" || e.key === "Meta") mod = true;
        if (space || mod) sync();
      };
      const up = (e) => {
        if (e.code === "Space") space = false;
        mod = e.ctrlKey || e.metaKey; // resync from the event's modifier state
        sync();
      };
      const reset = () => { space = false; mod = false; sync(); };
      window.addEventListener("keydown", down, true);
      window.addEventListener("keyup", up, true);
      window.addEventListener("blur", reset);
      return () => {
        window.removeEventListener("keydown", down, true);
        window.removeEventListener("keyup", up, true);
        window.removeEventListener("blur", reset);
      };
    }, [active]);

    // Rings only show while the tool is active (matches the built-in Heal tool).
    // Mapping helpers are null until the first frame lays out.
    if (!active || !imageRect || !toScreen) return null;
    const spots = readSpots(paramBag);

    const local = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    function hitSpot(lx, ly) {
      // Topmost first (last drawn). Returns {slot, mode}.
      for (let i = spots.length - 1; i >= 0; i--) {
        const sp = spots[i];
        const c = toScreen(sp.cx, sp.cy);
        const rs = Math.max(6, radiusToScreen(sp.ry));
        const dist = Math.hypot(lx - c.x, ly - c.y) / rs;
        if (dist <= 1.35) return { slot: sp.slot, mode: dist > 0.7 ? "resize" : "move" };
      }
      return null;
    }

    function onPointerDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const l = local(e);
      const hit = hitSpot(l.x, l.y);
      if (hit) {
        useTool.getState().select(hit.slot);
        const sp = spots.find((s) => s.slot === hit.slot);
        // Track the move as a source-UV delta so it's correct at any zoom/crop.
        drag.current = { slot: hit.slot, mode: hit.mode, downUV: toImage(l.x, l.y), cx0: sp.cx, cy0: sp.cy };
        return;
      }
      // Create on empty space.
      const slot = nextFreeSlot(dev().paramBag);
      if (slot < 0) return; // full
      const uv = toImage(l.x, l.y);
      let geo;
      const near = findBlobNear(uv.x, uv.y);
      if (near) geo = blobToGeo(near);
      else {
        const r = S("size") / 100;
        geo = [uv.x, uv.y, r, r];
      }
      applySpot(slot, geo, defaultPar(), false);
      useTool.getState().select(slot);
      // Drag immediately resizes (manual override of the auto/default radius).
      drag.current = { slot, mode: "resize", created: true };
    }

    function findBlobNear(ux, uy) {
      if (analysis.sig !== analysisSig() || !analysis.blobs.length) return null;
      let best = null, bestD = Infinity;
      for (const b of analysis.blobs) {
        const bx = b.cx / analysis.imgW, by = b.cy / analysis.imgH;
        const d = Math.hypot(bx - ux, by - uy);
        const tol = (b.radius / analysis.imgH) * 2 + 0.02;
        if (d < tol && d < bestD) { best = b; bestD = d; }
      }
      return best;
    }

    function onPointerMove(e) {
      const l = local(e);
      setCursor(l);
      const d = drag.current;
      if (!d) return;
      e.stopPropagation();
      const sp = readSpots(dev().paramBag).find((s) => s.slot === d.slot);
      if (!sp) return;
      if (d.mode === "move") {
        const cur = toImage(l.x, l.y);
        const cx = Math.min(1, Math.max(0, d.cx0 + (cur.x - d.downUV.x)));
        const cy = Math.min(1, Math.max(0, d.cy0 + (cur.y - d.downUV.y)));
        applySpot(d.slot, [cx, cy, sp.rx, sp.ry], null, true);
      } else {
        const c = toScreen(sp.cx, sp.cy);
        const rscreen = Math.max(4, Math.hypot(l.x - c.x, l.y - c.y));
        let r = radiusToImage(rscreen);
        r = Math.min(0.25, Math.max(0.003, r)); // clamp to sane pupil sizes
        applySpot(d.slot, [sp.cx, sp.cy, r, r], null, true);
      }
    }

    function endDrag(e) {
      if (!drag.current) return;
      e.stopPropagation();
      drag.current = null;
      flushLive();
      commit();
    }

    // --- render -----------------------------------------------------------
    const els = [];
    for (const sp of spots) {
      const c = toScreen(sp.cx, sp.cy);
      const r = Math.max(2, radiusToScreen(sp.ry));
      const sel = sp.slot === selected;
      const stroke = !sp.enabled ? "#8a8a8a" : sel ? "#ffffff" : "#e0e0e0";
      els.push(h("circle", {
        key: `e${sp.slot}`, cx: c.x, cy: c.y, r, fill: "none",
        stroke, strokeWidth: sel ? 2 : 1.2,
        strokeDasharray: sp.enabled ? (sel ? undefined : "3 3") : "2 4",
        opacity: sp.enabled ? 0.9 : 0.4,
      }));
      if (sel && sp.enabled) {
        els.push(h("circle", { key: `d${sp.slot}`, cx: c.x, cy: c.y, r: 1.5, fill: "#ffffff", opacity: 0.9 }));
      }
    }
    if (!passthrough && cursor && !drag.current) {
      els.push(h("circle", {
        key: "cursor", cx: cursor.x, cy: cursor.y, r: Math.max(4, radiusToScreen(S("size") / 100)),
        fill: "none", stroke: "#e0e0e0", strokeWidth: 1, strokeDasharray: "2 2", opacity: 0.6,
      }));
    }

    return h("div", {
      style: {
        position: "absolute", inset: 0,
        // Click-through during a pan/zoom gesture so the viewport beneath drives
        // pan/zoom; otherwise we own the pointer for placing/editing corrections.
        pointerEvents: passthrough ? "none" : "auto",
        // Use the app's shared crosshair token (so Custom Cursors themes restyle it)
        // instead of a hardcoded CSS keyword; fall back on older Safelight builds.
        cursor: passthrough
          ? "default"
          : (api.cursors && api.cursors.resolve ? api.cursors.resolve("crosshair") : "crosshair"),
      },
      onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag,
      onPointerLeave: () => setCursor(null),
    }, h("svg", {
      style: { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" },
    }, els));
  }

  api.registerSlot({ id: "redeye.overlay", slot: "develop-canvas-overlay", component: Overlay, order: 40 });

  // --- panel --------------------------------------------------------------

  function RedEyePanel() {
    const paramBag = useDevelopStore((s) => s.paramBag);
    const photoId = useDevelopStore((s) => s.photoId);
    const active = useTool((s) => s.active);
    const selected = useTool((s) => s.selected);
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState("");
    const [, bump] = React.useReducer((n) => n + 1, 0);
    React.useEffect(() => api.settings.onChange(bump), []); // live ⚙ edits

    // Generic chrome (buttons, layout) comes from the shared core UI kit so it
    // matches the app exactly; the Slider is a core component and the on-canvas
    // ring overlay is bespoke domain UI, both left as-is.
    if (!api.ui) return h("div", { style: { padding: "10px", fontSize: "11px", color: "var(--color-text-muted)" } }, "Update Safelight to use this panel.");
    const { Button, Row } = api.ui;

    const spots = readSpots(paramBag);
    const sel = selected != null ? spots.find((s) => s.slot === selected) || null : null;

    const setActive = (v) => {
      useTool.getState().setActive(v);
      if (v) dev().setActiveTool("none"); // suppress core mask/retouch overlays
    };

    const detect = async () => {
      setBusy(true);
      setStatus("Scanning…");
      try {
        const a = await ensureAnalysis();
        if (!a) { setStatus("Open a photo in Develop first."); return; }
        const bag = dev().paramBag;
        const existing = readSpots(bag);
        const cap = Math.min(S("maxDetections"), MAX_SPOTS - existing.length);
        if (cap <= 0) { setStatus(`Limit reached (${MAX_SPOTS} corrections).`); return; }
        let added = 0;
        const placed = existing.map((s) => ({ cx: s.cx, cy: s.cy, rx: s.rx }));
        for (const b of a.blobs) {
          if (added >= cap) break;
          const geo = blobToGeo(b);
          if (placed.some((o) => Math.hypot(o.cx - geo[0], o.cy - geo[1]) < o.rx + geo[2])) continue;
          const slot = nextFreeSlot(dev().paramBag);
          if (slot < 0) break;
          applySpot(slot, geo, defaultPar(), false);
          placed.push({ cx: geo[0], cy: geo[1], rx: geo[2] });
          added++;
        }
        if (added === 0) { setStatus("No new red eyes found. Raise sensitivity in ⚙, or click an eye."); return; }
        if (S("autoCommit")) commit();
        setActive(true);
        setStatus(`Corrected ${added} red eye${added === 1 ? "" : "s"}.`);
      } catch (err) {
        setStatus(`Detection failed: ${err?.message ?? err}`);
      } finally {
        setBusy(false);
      }
    };

    // Slider helpers: edit the selected spot, or the new-spot defaults (settings).
    const sizeVal = sel ? +(sel.ry * 100).toFixed(2) : S("size");
    const darkenVal = sel ? Math.round(sel.darken * 100) : S("darken");
    const desatVal = sel ? Math.round(sel.desat * 100) : S("desat");
    const featherVal = sel ? Math.round(sel.feather * 100) : S("feather");

    const setSize = (v) => {
      if (!sel) { api.settings.set("size", v); return; }
      const r = v / 100;
      applySpot(sel.slot, [sel.cx, sel.cy, r, r], null, false);
    };
    const setPar = (key, v) => {
      if (!sel) { api.settings.set(key === "feather" ? "feather" : key === "darken" ? "darken" : "desat", v); return; }
      const par = [sel.feather, sel.desat, sel.darken, sel.enabled ? 1 : 0];
      if (key === "feather") par[0] = v / 100;
      if (key === "desat") par[1] = v / 100;
      if (key === "darken") par[2] = v / 100;
      applySpot(sel.slot, null, par, false);
    };

    const editor = h("div", { className: "space-y-0.5 rounded bg-surface-2/50 p-1.5", key: "editor" },
      h(Slider, { label: "Size", value: sizeVal, min: 0.2, max: 10, step: 0.1, defaultValue: DEFAULTS.size, onChange: setSize, onCommit: () => sel && commit() }),
      h(Slider, { label: "Darken", value: darkenVal, min: 0, max: 100, step: 1, defaultValue: DEFAULTS.darken, onChange: (v) => setPar("darken", v), onCommit: () => sel && commit() }),
      h(Slider, { label: "Desaturate", value: desatVal, min: 0, max: 100, step: 1, defaultValue: DEFAULTS.desat, onChange: (v) => setPar("desat", v), onCommit: () => sel && commit() }),
      h(Slider, { label: "Feather", value: featherVal, min: 0, max: 100, step: 1, defaultValue: DEFAULTS.feather, onChange: (v) => setPar("feather", v), onCommit: () => sel && commit() }),
    );

    return h(Panel, { title: "Red Eye" },
      h("div", { className: "space-y-2" },
        h(Row, { gap: 4, align: "center" },
          h(Button, {
            variant: "primary",
            active,
            full: true,
            disabled: !photoId,
            onClick: () => setActive(!active),
          }, active ? "Done" : "Correct"),
          h(Button, {
            variant: "secondary",
            full: true,
            disabled: busy || !photoId,
            onClick: detect,
          }, busy ? "Scanning…" : "Auto-detect"),
        ),
        active && h("div", { className: "text-[10px] text-text-muted" }, TOOL_HINT),
        status && h("div", { className: "text-[10px] text-text-muted" }, status),
        spots.length >= MAX_SPOTS && h("div", { className: "text-[10px] text-label-red" },
          `Correction limit (${MAX_SPOTS}) reached.`),
        spots.length > 0 && h("div", { className: "space-y-0.5" },
          spots.map((s, i) =>
            h("div", {
              key: s.slot,
              onClick: () => { useTool.getState().select(s.slot); setActive(true); },
              className: "group flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] " +
                (s.slot === selected ? "bg-accent/20 text-text-primary" : "text-text-secondary hover:bg-surface-2"),
            },
              h(Button, {
                variant: "ghost",
                size: "sm",
                title: s.enabled ? "Hide" : "Show",
                onClick: (e) => {
                  e.stopPropagation();
                  applySpot(s.slot, null, [s.feather, s.desat, s.darken, s.enabled ? 0 : 1], false);
                  commit();
                },
              }, s.enabled ? "◉" : "○"),
              h("span", { className: "flex-1 truncate" }, `Eye ${i + 1}`),
              // Match the app's hover-reveal delete control (core MasksPanel): a
              // muted "×" hidden until the row (.group) is hovered, then shown
              // (group-hover:opacity-100) and turning red on its own hover.
              h("button", {
                type: "button",
                title: "Remove",
                className: "rounded px-1 text-text-muted opacity-0 hover:text-label-red group-hover:opacity-100",
                onClick: (e) => {
                  e.stopPropagation();
                  removeSpot(s.slot);
                  if (selected === s.slot) useTool.getState().select(null);
                  commit();
                },
              }, "×"),
            ),
          ),
        ),
        editor,
        spots.length === 0 && !status &&
          h("div", { className: "text-[10px] text-text-muted" },
            "Auto-detect scans the photo, or press Correct and click each eye. Drag to size; drag a ring to move."),
      ),
    );
  }

  api.registerPanel({
    id: "redeye.panel",
    title: "Red Eye",
    component: RedEyePanel,
    defaultDock: { module: "develop", direction: "right", order: 6, width: 280, height: 240 },
  });
}

export function deactivate() {
  // Panels/slots/settings are auto-swept by the host. Drop the GPU stage too so
  // disabling the extension stops contributing to the render pipeline.
  try { unregisterStage?.(); } catch { /* host may have already swept it */ }
  try { unsubTool?.(); } catch { /* already torn down */ }
  unregisterStage = null;
  unsubTool = null;
}
