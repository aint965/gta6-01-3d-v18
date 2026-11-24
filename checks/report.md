# GTA 6 3D v18 — Stage A report

Repo: https://github.com/aint965/gta6-01-3d-v18
Branch: main. Date: 24 Nov 2026, ~07:30 WIB.
Scope: renderer + city (Stage A only). No submit, no bundle.

## Verdict: PASS — all Stage A gates green

| Gate | Result |
|---|---|
| Layout verifier (`node checks/layout.mjs`) | **0 problems** |
| Headless drive (`node checks/drive.mjs 8128`) | **4/4 shots OK, 0 console errors** |
| Packaging (`node checks/package.mjs`) | **2× byte-identical** |
| Screenshots | **4/4 viewed by eye** |

## Layout (seed 20261123)

- Buildings **689** (≥500), trees 211, lamps 189, traffic lights 13, boats 7
- Cars 119: parked 73, drivable 8, traffic 38
- Pedestrians 40 (all on sidewalks), sidewalks 878, corner pads 312, bridges 3
- Districts: citrus 168, market 289, canal 20, beach 45, glass 109, marina 21, old 37
- Checks passed: plaza clear, no building corner on a road, no car inside a
  building, all pedestrians on sidewalks, boulevard sidewalk coverage both
  sides every segment, bridge walkways, facade colour + front face on all
  buildings.

## Drive (chrome-headless-shell, swiftshader, 1280×720)

- `1-boulevard-day.jpg` — 100,816 B
- `2-sunset-street.jpg` — 81,804 B
- `3-night.jpg` — 98,512 B
- `4-plaza.jpg` — 141,171 B
- All < 256 KiB. Probe: `staticVerts=1,649,262`, `carVerts=12,138`, buildings 689.
- 0 console errors, 0 page errors, 0 failed requests.

## Packaging

- Dossier 644,307 bytes, sha256 `68c6c45970c591c8…` (both runs)
- Output tree hash `8d07c5e5cdf9beef…` (both runs) — byte-identical.

## Fixes made during this stage (all verified by re-run + re-view)

1. **Marina district had 0 buildings** — `districtAt` in `city.js` counted the
   harbour water cells as marina; changed to the waterfront strip (x > 2880,
   z 2160–3240). Now 21 marina buildings.
2. **Boulevard rendered GREEN at street level** (hero shot) — the road quads
   (y=0.02), plaza disc (0.015), water (0.03) and dashes (+0.005) sat almost
   coplanar with the ground plane and lost the depth test at glancing angles
   in the software renderer (from directly above they rendered fine).
   Raised: roads 0.02 → 0.12, dashes +0.05, plaza disc → 0.08, water → 0.10,
   beach/park → 0.05. Road is now asphalt with centre dashes in every shot.
   Also kept diagonal buildings, scattered trees and traffic off the roads
   (`pointOnRoad` guard) and parked/traffic cars out of the plaza.
3. **Sky band line** — the dome used one flat colour per ring (7 rings), so a
   hard horizontal line crossed the sky. Now per-vertex colours interpolated
   between adjacent rings (`skyQuad` in `mesh.js`); gradient is smooth in
   day/sunset/night.
4. **Night shot composition** — the first night camera sat over an empty dark
   grass courtyard. Moved onto the boulevard
   `(1920, 6, 2080, yaw 0.3)` — road, dashes, taillights, lit windows, tower,
   stars in frame.
5. **Driver rewrite** — CDP `Page.captureScreenshot` hung in headless-shell;
   rewrote `checks/drive.mjs` to drive chrome directly via
   `--screenshot` / `--dump-dom` with `--virtual-time-budget=1000`
   (6000 never expired under the continuous rAF loop). Also filtered the
   harmless Node `MODULE_TYPELESS_PACKAGE_JSON` warning out of the server
   stderr check, and added a `#probe` div in `main.js` for the dump-dom run.

## Screenshots viewed — honest notes

- Day boulevard: asphalt + dashes + sidewalks both sides + tower + window
  grids. Good hero shot.
- Sunset: smooth orange gradient, lit windows, tower, asphalt street. Sun
  disc itself is occluded by the tower (glow visible); acceptable.
- Night: boulevard, lit windows, tower, taillights, stars. Moon not in frame
  at this angle; night mood carries via windows + stars.
- Plaza aerial: city fabric reads (dense blocks, parapets, Glasspoint towers,
  diagonal Old Solmar street). Foreground bottom-left is a large empty grass
  block interior.
- Remaining nits (Stage C candidates, not Stage A blockers): plaza-aerial
  foreground grass is empty; sunset sun disc occluded; moon out of frame at
  night.

## Process notes

- Recorder pid 13857 verified alive at commit time (47 min elapsed).
- One deviation: the five road `y: 0.02 → 0.12` values in `city.js` were
  changed with a `sed` call via exec instead of the edit tool; the result was
  verified by grep and by the layout + drive re-runs. All other file writes
  used the write/edit tools.
- Starter files byte-identical to the kit (verified at session start);
  no README.md written; nothing submitted or bundled.
- `main.js` revised after running (probe div, then night-camera improvement)
  per the transcript rule; every counted file was written, run, and edited
  in-session.
