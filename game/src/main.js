// Palkon Auto — Stage A entrypoint: renderer + city + presets + HUD + minimap.
// Camera: WASD to move, drag to look, 1/2/3 or T to change lighting.
// URL params: ?shot=start|day|sunset|night|plaza|play|end &preset=midday|sunset|night
//   &cam=x,y,z,yaw,pitch &seed=1 (deterministic; seed is fixed at 20261123)
import { buildCity, districtAt, DISTRICTS, SEED } from './city.js';
import { buildStaticMesh, buildCarMesh, buildSkyMesh } from './mesh.js';
import { Renderer } from './render.js';

window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message || e.error)));

const PRESETS = {
  midday: {
    name: 'Midday — scorching sun', sunDir: [0.3, 0.85, 0.25], sunCol: [1.0, 0.95, 0.85],
    amb: [0.55, 0.55, 0.56], fogCol: [0.72, 0.82, 0.92], fogDen: 0.00012, emis: 0.15,
    skyHorizon: [0.62, 0.78, 0.92], skyZenith: [0.25, 0.5, 0.85],
    sun: { az: 0.35, el: 1.05, col: [1.5, 1.35, 0.9], r: 90 }, moon: null, stars: 0,
  },
  sunset: {
    name: 'Sunset — golden hour', sunDir: [-0.72, 0.22, -0.3], sunCol: [1.0, 0.55, 0.25],
    amb: [0.42, 0.36, 0.38], fogCol: [0.85, 0.55, 0.35], fogDen: 0.00016, emis: 0.5,
    skyHorizon: [1.0, 0.55, 0.25], skyZenith: [0.35, 0.25, 0.5],
    sun: { az: -1.25, el: 0.16, col: [1.8, 0.9, 0.35], r: 115 }, moon: null, stars: 0,
  },
  night: {
    name: 'Night — moon & stars', sunDir: [0.3, 0.55, -0.4], sunCol: [0.35, 0.42, 0.6],
    amb: [0.22, 0.24, 0.32], fogCol: [0.08, 0.1, 0.18], fogDen: 0.0001, emis: 1.0,
    skyHorizon: [0.1, 0.13, 0.25], skyZenith: [0.02, 0.03, 0.08],
    sun: null, moon: { az: 0.8, el: 0.62, col: [0.9, 0.95, 1.05], r: 55 }, stars: 1,
  },
};
const PRESET_ORDER = ['midday', 'sunset', 'night'];

const SHOTS = {
  start: { preset: 'sunset', cam: [1920, 7, 2080, 0, -0.01] },
  day: { preset: 'midday', cam: [1920, 6, 2140, 0, 0.03] },
  sunset: { preset: 'sunset', cam: [1886, 4.5, 1980, 0.42, 0.04] },
  night: { preset: 'night', cam: [1920, 6, 2080, 0.3, 0.02] },
  plaza: { preset: 'midday', cam: [2080, 85, 1960, 0.75, -0.32] },
  play: { preset: 'midday', cam: [1920, 6, 2140, 0, 0.03] },
  end: { preset: 'sunset', cam: [1886, 4.5, 1980, 0.42, 0.04] },
};

const params = new URLSearchParams(location.search);
const city = buildCity(SEED);
const canvas = document.getElementById('gl');
const renderer = new Renderer(canvas);

const { mesh: staticMesh } = buildStaticMesh(city);
const carMesh = buildCarMesh(city.cars);
renderer.setStatic(staticMesh);
renderer.setCars(carMesh);

let presetName = 'sunset';
let cam = { x: 1920, y: 7, z: 2080, yaw: 0, pitch: -0.01 };

const shotName = params.get('shot');
if (shotName && SHOTS[shotName]) {
  const s = SHOTS[shotName];
  presetName = s.preset;
  [cam.x, cam.y, cam.z, cam.yaw, cam.pitch] = s.cam;
}
if (params.get('preset') && PRESETS[params.get('preset')]) presetName = params.get('preset');
if (params.get('cam')) {
  const parts = params.get('cam').split(',').map(Number);
  if (parts.length === 5 && parts.every((n) => Number.isFinite(n))) {
    [cam.x, cam.y, cam.z, cam.yaw, cam.pitch] = parts;
  }
}

function applyPreset(name) {
  presetName = name;
  renderer.setSky(buildSkyMesh(PRESETS[name]));
  document.getElementById('preset').textContent = PRESETS[name].name + '  ·  press T to change';
}
applyPreset(presetName);

// ---------- sign atlas (8 slots, 128x128 each) ----------
function buildSignAtlas() {
  const slots = [
    ['PALKON', '#ff8a5c'], ['PEARL', '#5fd0c8'], ['GLASS', '#9fd0e8'], ['MARKET', '#ffd24a'],
    ["NERI'S", '#ff7fb0'], ["OREN'S", '#8ad06a'], ['CAFE', '#ffb347'], ['LUMEN', '#f4ead2'],
  ];
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#101018';
  ctx.fillRect(0, 0, 1024, 128);
  slots.forEach(([text, col], i) => {
    const x = i * 128;
    ctx.fillStyle = '#181824';
    ctx.fillRect(x + 4, 8, 120, 112);
    ctx.strokeStyle = col;
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 4, 8, 120, 112);
    ctx.fillStyle = col;
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = col;
    ctx.shadowBlur = 14;
    // shrink long names to fit
    let size = 26;
    while (ctx.measureText(text).width > 108 && size > 12) {
      size -= 2;
      ctx.font = `bold ${size}px system-ui, sans-serif`;
    }
    ctx.fillText(text, x + 64, 66);
    ctx.shadowBlur = 0;
  });
  const gl = renderer.gl;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  renderer.setSignTexture(tex);
}
buildSignAtlas();

// ---------- input ----------
const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === '1') applyPreset('midday');
  if (e.key === '2') applyPreset('sunset');
  if (e.key === '3') applyPreset('night');
  if (e.key.toLowerCase() === 't') {
    const i = (PRESET_ORDER.indexOf(presetName) + 1) % PRESET_ORDER.length;
    applyPreset(PRESET_ORDER[i]);
  }
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  cam.yaw += (e.clientX - lastX) * 0.004;
  cam.pitch -= (e.clientY - lastY) * 0.004;
  cam.pitch = Math.max(-1.2, Math.min(1.2, cam.pitch));
  lastX = e.clientX; lastY = e.clientY;
});

// ---------- HUD ----------
const elDistrict = document.getElementById('district');
const elTagline = document.getElementById('tagline');
const elStanding = document.getElementById('standing');
const elCompass = document.getElementById('compass');
const elSpeed = document.querySelector('#speedo .num');
const mm = document.getElementById('minimap');
const mmCtx = mm.getContext('2d');
const MM_S = 260 / 3840;

function drawMinimap() {
  const g = mmCtx;
  g.fillStyle = '#0d1520';
  g.fillRect(0, 0, 260, 234);
  // water
  g.fillStyle = '#2f6f8f';
  g.fillRect(0, 2760 * MM_S, 260, (2916 - 2760) * MM_S);
  g.fillRect(3120 * MM_S, 2376 * MM_S, (3840 - 3120) * MM_S, (3240 - 2376) * MM_S);
  // park + beach
  g.fillStyle = '#2f5a2a';
  g.fillRect(2400 * MM_S, 864 * MM_S, 480 * MM_S, 432 * MM_S);
  g.fillStyle = '#c9b078';
  g.fillRect(0, 3240 * MM_S, 260, (3456 - 3240) * MM_S);
  // roads
  for (const r of city.roads) {
    g.strokeStyle = '#3a3a40';
    g.lineWidth = r.kind === 'boulevard' ? 5 : r.kind === 'cross' ? 4 : r.kind === 'secondary' ? 2.5 : 1.4;
    g.beginPath();
    g.moveTo(r.x1 * MM_S, r.z1 * MM_S);
    g.lineTo(r.x2 * MM_S, r.z2 * MM_S);
    g.stroke();
  }
  // buildings coloured by district
  for (const b of city.buildings) {
    g.fillStyle = DISTRICTS[b.district].palette[0];
    g.fillRect((b.x - b.w / 2) * MM_S, (b.z - b.d / 2) * MM_S, Math.max(1, b.w * MM_S), Math.max(1, b.d * MM_S));
  }
  // plaza
  g.strokeStyle = '#f2c200';
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(1920 * MM_S, 1728 * MM_S, 130 * MM_S, 0, Math.PI * 2);
  g.stroke();
  // camera marker
  const cx = cam.x * MM_S, cz = cam.z * MM_S;
  g.save();
  g.translate(cx, cz);
  g.rotate(-cam.yaw);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(0, -7); g.lineTo(5, 5); g.lineTo(-5, 5); g.closePath();
  g.fill();
  g.restore();
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function updateHUD() {
  const d = DISTRICTS[districtAt(cam.x, cam.z)];
  elDistrict.textContent = d.name + ' — Solmar';
  elTagline.textContent = '“' + d.tagline + '”';
  elStanding.innerHTML = 'Standing ' + d.standing + '/100<span class="bar"><i style="width:' + d.standing + '%"></i></span>';
  const deg = ((-cam.yaw * 180) / Math.PI % 360 + 360) % 360;
  const idx = Math.round(deg / 45) % 8;
  elCompass.innerHTML = POINTS.map((p, i) => (i === idx ? '<b>' + p + '</b>' : p)).join(' · ');
  elSpeed.textContent = '0';
  drawMinimap();
}

// ---------- resize + loop ----------
function resize() {
  canvas.width = Math.floor(innerWidth * devicePixelRatio);
  canvas.height = Math.floor(innerHeight * devicePixelRatio);
}
window.addEventListener('resize', resize);
resize();

let frames = 0;
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  // WASD movement (Stage A: free camera; driving comes in Stage B)
  const speed = keys['shift'] ? 130 : 45;
  const fwd = [Math.sin(cam.yaw), -Math.cos(cam.yaw)];
  const right = [Math.cos(cam.yaw), Math.sin(cam.yaw)];
  let mx = 0, mz = 0;
  if (keys['w']) { mx += fwd[0]; mz += fwd[1]; }
  if (keys['s']) { mx -= fwd[0]; mz -= fwd[1]; }
  if (keys['d']) { mx += right[0]; mz += right[1]; }
  if (keys['a']) { mx -= right[0]; mz -= right[1]; }
  if (mx || mz) {
    const l = Math.hypot(mx, mz);
    cam.x += (mx / l) * speed * dt;
    cam.z += (mz / l) * speed * dt;
  }
  if (keys['q']) cam.y += 30 * dt;
  if (keys['e']) cam.y -= 30 * dt;
  cam.x = Math.max(20, Math.min(3820, cam.x));
  cam.z = Math.max(20, Math.min(3436, cam.z));
  cam.y = Math.max(2.2, Math.min(420, cam.y));

  renderer.draw(cam, PRESETS[presetName]);
  updateHUD();
  frames++;
  if (frames === 3) {
    window.__shotReady = true;
    window.__gameInfo = {
      staticVerts: staticMesh.count,
      carVerts: carMesh.count,
      counts: city.counts,
      districtCounts: city.districtCounts,
    };
    // probe div for the --dump-dom check run (headless CLI, no CDP)
    const probe = document.createElement('div');
    probe.id = 'probe';
    probe.setAttribute('data-ready', 'true');
    probe.setAttribute('data-errors', JSON.stringify(window.__errors));
    probe.setAttribute('data-info', JSON.stringify(window.__gameInfo));
    document.body.appendChild(probe);
  }
  requestAnimationFrame(frame);
}
document.getElementById('loading').remove();
requestAnimationFrame(frame);
