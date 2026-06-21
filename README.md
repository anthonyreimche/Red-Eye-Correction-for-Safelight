# SafeLight Red Eye Correction

A dedicated, **heal-style** red-eye tool for [SafeLight](https://github.com/anthonyreimche/SafeLight). It draws interactive correction rings right on the photo — click an eye, drag to size, tune each one — and fixes it on the GPU by neutralizing the red glow while preserving the white catchlight.

Corrections are non-destructive: they render live, undo/redo with the normal edit history, and bake into exports. Unlike the previous version, they are **not** masks — they don't appear in the Masks panel and don't count toward the app's 8-mask limit.

## Install

Extensions panel (**View ▸ Extensions**) → enter `owner/safelight-redeye` (or the github.com URL). No restart needed.

## Use

Open a photo in **Develop**. The **Red Eye** panel docks in the right rail.

- **Auto-detect all** — scans the photo for compact, strongly red blobs and corrects each one.
- **Correct / Done** — toggles the on-canvas tool. While active:
  - **Click** an eye to drop a correction (it auto-sizes to the pupil if detection finds one there).
  - **Drag** while placing to set the radius by hand.
  - **Drag a ring** to move it; **drag its edge** to resize.
- In the list, the eye icon (◉ / ○) hides/shows a correction, and ✕ removes it. **Clear** removes all.
- Select a correction (click its ring or list row) to tune **Size**, **Darken**, **Desaturate**, and **Feather**. With nothing selected, those sliders edit the defaults used for new corrections.

Up to **8** corrections per photo.

## How the correction works

Each correction is a feathered disc. On the GPU, every pixel inside the disc is weighted by how *red* it actually is (`r − max(g, b)`), so only the red-eye glow is touched — the white catchlight and surrounding skin are left alone. Affected pixels get their red channel pulled down toward the green/blue average (killing the glow), are desaturated toward neutral, and darkened to a natural pupil. The corrections live as the GPU stage's uniform values in the per-photo edit, which is why they survive undo/redo and export automatically.

## How detection works

The photo is decoded (RAW falls back to the cached thumbnail), downscaled to the analysis resolution, and scored per pixel for red dominance (`r² / (g² + b² + floor)`). Pixels above the sensitivity threshold are flood-filled into connected components, filtered by size, aspect ratio (~round), and compactness, deduplicated by overlap, and ranked by confidence. The same detection powers **Auto-detect all** and the click-to-auto-size placement.

## Extension settings (⚙ in the Extensions panel)

| Setting | Default | Effect |
|---|---|---|
| Detection sensitivity | 60 | Higher finds fainter red eyes; risks false positives |
| Min / max pupil size | 0.3% / 4% | Accepted blob radius, as % of image height |
| Max detections per run | 6 | Cap per Auto-detect click (≤ 8) |
| Default size | 2% | Radius of a fresh correction before drag/auto-size |
| Default feather / desaturation / darken | 40 / 90 / 55 | Applied to new corrections |
| Analysis resolution | 1200 px | Long edge for scanning; lower = faster |
| Add history step after detect | on | Commits an undoable snapshot |

Settings apply live — no reload.

## Repo layout

- `safelight.json` — manifest
- `dist/index.js` — the ESM bundle (hand-written, dependency-free; React, components, and stores come from the `SafelightAPI`, so there is no build step). It contributes a GPU processing stage, a `develop-canvas-overlay` slot, and a panel.

Tag the repo with the `safelight-extension` topic to appear in the in-app browser.

## License

MIT
