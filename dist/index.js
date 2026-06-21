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

const KGEO = (i) => `${STAGE_ID}.uReGeo${i}`; // vec4 [cx, cy, rx, ry] (image-UV)
const KPAR = (i) => `${STAGE_ID}.uRePar${i}`; // vec4 [feather, desat, darken, enabled] (0..1)
const KCOUNT = `${STAGE_ID}.uReCount`;

let unregisterStage = null; // set in activate, called from deactivate

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
  if (geo.z <= 0.0 || geo.w <= 0.0) return c; // empty slot
  vec2 d = (uv - geo.xy) / vec2(geo.z, geo.w); // normalize to the disc radii
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
    glsl: "c = reApply(c, vUv);",
    helpers,
    uniforms,
  };
}

// ---------------------------------------------------------------------------
// Detection: redness score -> binary mask -> connected components -> filters
// ---------------------------------------------------------------------------

/**
 * Scan RGBA pixels for compact, strongly red blobs.
 * Returns up to maxCount blobs as { cx, cy, radius } in *pixels* of the
 * analyzed image, sorted by confidence, overlaps deduplicated.
 */
function detectRedEyes(data, w, h, opts) {
  const n = w * h;
  const thr = 2.2 - (opts.sensitivity / 100) * 1.4;
  const mask = new Uint8Array(n);
  const score = new Float32Array(n);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p];
    if (r < 50) continue;
    const g = data[p + 1];
    const b = data[p + 2];
    const s = (r * r) / (g * g + b * b + 1400);
    if (s > thr) {
      mask[i] = 1;
      score[i] = s;
    }
  }

  const minR = (opts.minPupil / 100) * h;
  const maxR = (opts.maxPupil / 100) * h;
  const stack = new Int32Array(n);
  const blobs = [];

  for (let seed = 0; seed < n; seed++) {
    if (mask[seed] !== 1) continue;
    let top = 0;
    stack[top++] = seed;
    mask[seed] = 2;
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
      if (x > 0 && mask[q - 1] === 1) { mask[q - 1] = 2; stack[top++] = q - 1; }
      if (x < w - 1 && mask[q + 1] === 1) { mask[q + 1] = 2; stack[top++] = q + 1; }
      if (y > 0 && mask[q - w] === 1) { mask[q - w] = 2; stack[top++] = q - w; }
      if (y < h - 1 && mask[q + w] === 1) { mask[q + w] = 2; stack[top++] = q + w; }
    }
    const radius = Math.sqrt(area / Math.PI);
    if (radius < minR || radius > maxR) continue;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const aspect = bw / bh;
    if (aspect < 0.4 || aspect > 2.5) continue;
    if (area / (bw * bh) < 0.4) continue;
    blobs.push({ cx: sx / area, cy: sy / area, radius, weight });
  }

  blobs.sort((a, b) => b.weight - a.weight);
  const out = [];
  for (const b of blobs) {
    if (out.length >= opts.maxCount) break;
    if (out.some((o) => Math.hypot(o.cx - b.cx, o.cy - b.cy) < o.radius + b.radius)) continue;
    out.push(b);
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

  function clearAll() {
    const patch = { [KCOUNT]: 0 };
    for (let i = 0; i < MAX_SPOTS; i++) { patch[KGEO(i)] = [0, 0, 0, 0]; patch[KPAR(i)] = [0, 0, 0, 0]; }
    dev().setDynParams(patch);
  }

  const commit = () => void dev().commitEdit("Red eye");
  const defaultPar = () => [S("feather") / 100, S("desat") / 100, S("darken") / 100, 1];

  /** Aspect (w/h) of the active photo, for converting a height-based radius to
   *  the per-axis UV radii that keep the disc circular on screen. */
  function photoAspect() {
    const photo = useCatalogStore.getState().photos.find((p) => p.id === dev().photoId);
    return photo && photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 1.5;
  }

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

  /** Blob (analysis px) -> geo vec4 [cx, cy, rx, ry] in image-UV. Per-axis radii
   *  derived from image pixel dims keep the disc circular on screen. */
  function blobToGeo(b) {
    const pad = 1.3; // cover the pupil plus a little of the iris edge
    const r = b.radius * pad;
    return [b.cx / analysis.imgW, b.cy / analysis.imgH, r / analysis.imgW, r / analysis.imgH];
  }

  // --- canvas overlay -----------------------------------------------------

  function Overlay() {
    const { rect } = api.develop.useDevelopOverlay();
    const paramBag = useDevelopStore((s) => s.paramBag);
    const active = useTool((s) => s.active);
    const selected = useTool((s) => s.selected);
    const photoId = useDevelopStore((s) => s.photoId);
    const [cursor, setCursor] = React.useState(null); // {x,y} local px
    const drag = React.useRef(null);

    // Prefetch detection so a click can auto-size synchronously.
    React.useEffect(() => {
      if (active) void ensureAnalysis();
    }, [active, photoId]);

    // Rings only show while the tool is active (matches the built-in Heal tool;
    // keeps the photo clean during normal viewing).
    if (!rect || !active) return null;
    const spots = readSpots(paramBag);

    const toScreen = (cx, cy) => ({ x: rect.x + cx * rect.w, y: rect.y + cy * rect.h });
    const local = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    function hitSpot(lx, ly) {
      // Topmost first (last drawn). Returns {slot, mode}.
      for (let i = spots.length - 1; i >= 0; i--) {
        const sp = spots[i];
        const c = toScreen(sp.cx, sp.cy);
        const dx = (lx - c.x) / Math.max(1, sp.rx * rect.w);
        const dy = (ly - c.y) / Math.max(1, sp.ry * rect.h);
        const dist = Math.hypot(dx, dy);
        if (dist <= 1.35) return { slot: sp.slot, mode: dist > 0.7 ? "resize" : "move" };
      }
      return null;
    }

    function onPointerDown(e) {
      if (!active || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const lx = local(e).x, ly = local(e).y;
      const hit = hitSpot(lx, ly);
      if (hit) {
        useTool.getState().select(hit.slot);
        const sp = spots.find((s) => s.slot === hit.slot);
        const c = toScreen(sp.cx, sp.cy);
        drag.current = { slot: hit.slot, mode: hit.mode, offX: c.x - lx, offY: c.y - ly };
        return;
      }
      // Create on empty space.
      const bag = dev().paramBag;
      const slot = nextFreeSlot(bag);
      if (slot < 0) return; // full
      const ux = (lx - rect.x) / rect.w;
      const uy = (ly - rect.y) / rect.h;
      let geo;
      const near = findBlobNear(ux, uy);
      if (near) geo = blobToGeo(near);
      else {
        const ry = S("size") / 100;
        geo = [ux, uy, ry * rect.h / rect.w, ry];
      }
      applySpot(slot, geo, defaultPar(), false);
      useTool.getState().select(slot);
      // Drag immediately resizes (manual override of the auto/default radius).
      drag.current = { slot, mode: "resize", offX: 0, offY: 0, created: true };
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
      setCursor(active ? l : null);
      const d = drag.current;
      if (!d) return;
      e.stopPropagation();
      const sp = readSpots(dev().paramBag).find((s) => s.slot === d.slot);
      if (!sp) return;
      if (d.mode === "move") {
        const cx = Math.min(1, Math.max(0, (l.x + d.offX - rect.x) / rect.w));
        const cy = Math.min(1, Math.max(0, (l.y + d.offY - rect.y) / rect.h));
        applySpot(d.slot, [cx, cy, sp.rx, sp.ry], null, true);
      } else {
        const c = toScreen(sp.cx, sp.cy);
        const rscreen = Math.max(4, Math.hypot(l.x - c.x, l.y - c.y));
        let rx = rscreen / rect.w;
        let ry = rscreen / rect.h;
        const maxRy = 0.25, minRy = 0.003; // clamp to sane pupil sizes
        if (ry > maxRy) { rx *= maxRy / ry; ry = maxRy; }
        if (ry < minRy) { rx *= minRy / ry; ry = minRy; }
        applySpot(d.slot, [sp.cx, sp.cy, rx, ry], null, true);
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
      const rx = sp.rx * rect.w, ry = sp.ry * rect.h;
      const sel = sp.slot === selected;
      const stroke = !sp.enabled ? "#8a8a8a" : sel ? "#ffffff" : "#e0e0e0";
      els.push(h("ellipse", {
        key: `e${sp.slot}`, cx: c.x, cy: c.y, rx, ry, fill: "none",
        stroke, strokeWidth: sel ? 2 : 1.2,
        strokeDasharray: sp.enabled ? (sel ? undefined : "3 3") : "2 4",
        opacity: sp.enabled ? 0.9 : 0.4,
      }));
      if (sel && sp.enabled) {
        els.push(h("circle", { key: `d${sp.slot}`, cx: c.x, cy: c.y, r: 1.5, fill: "#ffffff", opacity: 0.9 }));
      }
    }
    if (active && cursor && !drag.current) {
      const ry = (S("size") / 100) * rect.h;
      els.push(h("circle", {
        key: "cursor", cx: cursor.x, cy: cursor.y, r: Math.max(4, ry),
        fill: "none", stroke: "#e0e0e0", strokeWidth: 1, strokeDasharray: "2 2", opacity: 0.6,
      }));
    }

    return h("div", {
      style: {
        position: "absolute", inset: 0,
        pointerEvents: active ? "auto" : "none",
        cursor: active ? "crosshair" : "default",
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
      const ry = v / 100;
      const rx = ry / photoAspect();
      applySpot(sel.slot, [sel.cx, sel.cy, rx, ry], null, false);
    };
    const setPar = (key, v) => {
      if (!sel) { api.settings.set(key === "feather" ? "feather" : key === "darken" ? "darken" : "desat", v); return; }
      const par = [sel.feather, sel.desat, sel.darken, sel.enabled ? 1 : 0];
      if (key === "feather") par[0] = v / 100;
      if (key === "desat") par[1] = v / 100;
      if (key === "darken") par[2] = v / 100;
      applySpot(sel.slot, null, par, false);
    };

    const btn = "rounded px-2 py-1 text-[11px]";
    const toggleBtn = active
      ? "bg-accent/30 text-text-primary"
      : "bg-surface-2 text-text-secondary hover:text-text-primary";
    const plainBtn = "bg-surface-2 text-text-secondary hover:text-text-primary";

    const editor = h("div", { className: "space-y-0.5 rounded bg-surface-2/50 p-1.5", key: "editor" },
      h(Slider, { label: "Size", value: sizeVal, min: 0.2, max: 10, step: 0.1, defaultValue: DEFAULTS.size, onChange: setSize, onCommit: () => sel && commit() }),
      h(Slider, { label: "Darken", value: darkenVal, min: 0, max: 100, step: 1, defaultValue: DEFAULTS.darken, onChange: (v) => setPar("darken", v), onCommit: () => sel && commit() }),
      h(Slider, { label: "Desaturate", value: desatVal, min: 0, max: 100, step: 1, defaultValue: DEFAULTS.desat, onChange: (v) => setPar("desat", v), onCommit: () => sel && commit() }),
      h(Slider, { label: "Feather", value: featherVal, min: 0, max: 100, step: 1, defaultValue: DEFAULTS.feather, onChange: (v) => setPar("feather", v), onCommit: () => sel && commit() }),
    );

    return h(Panel, { title: "Red Eye" },
      h("div", { className: "space-y-2" },
        h("div", { className: "flex items-center gap-1" },
          h("button", {
            className: `${btn} ${toggleBtn}`,
            disabled: !photoId,
            onClick: () => setActive(!active),
          }, active ? "Done" : "Correct"),
          h("button", {
            className: `${btn} ${plainBtn}`,
            disabled: busy || !photoId,
            onClick: detect,
          }, busy ? "Scanning…" : "Auto-detect all"),
          spots.length > 0 && h("button", {
            className: `${btn} ${plainBtn}`,
            onClick: () => { clearAll(); useTool.getState().select(null); commit(); setStatus(""); },
          }, "Clear"),
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
              className: "flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] " +
                (s.slot === selected ? "bg-accent/20 text-text-primary" : "text-text-secondary hover:bg-surface-2"),
            },
              h("button", {
                className: "shrink-0 rounded px-0.5",
                title: s.enabled ? "Hide" : "Show",
                onClick: (e) => {
                  e.stopPropagation();
                  applySpot(s.slot, null, [s.feather, s.desat, s.darken, s.enabled ? 0 : 1], false);
                  commit();
                },
              }, s.enabled ? "◉" : "○"),
              h("span", { className: "flex-1 truncate" }, `Eye ${i + 1}`),
              h("button", {
                className: "shrink-0 rounded px-1 text-text-muted hover:text-label-red",
                title: "Remove",
                onClick: (e) => {
                  e.stopPropagation();
                  removeSpot(s.slot);
                  if (selected === s.slot) useTool.getState().select(null);
                  commit();
                },
              }, "✕"),
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
  unregisterStage = null;
}
