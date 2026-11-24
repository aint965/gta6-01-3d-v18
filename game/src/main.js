// Palkon Auto — Stage B entrypoint: Game + renderer + city + presets + HUD.
// Camera: chase cam behind Mara / the driven car (drag orbits, eases back).
// URL params: ?shot=start|day|sunset|night|plaza|play|end &preset=midday|sunset|night
//   &cam=x,y,z,yaw,pitch &seed=1 (deterministic; city seed is fixed at 20261123)
//   &drive=day|night (auto-enter the nearest northbound drivable car and
//   drive up the boulevard — for the headless drive screenshots)
//   &mission=N (teleport Mara to mission N's pickup and start it — for the
//   mission HUD/marker screenshot) &haze=off (fog off — headlight test)
import { buildCity, districtAt, DISTRICTS, SEED } from './city.js';
import { buildStaticMesh, buildCarMesh, buildSkyMesh, buildBeamMesh, buildMarkerMesh, buildMaraMesh } from './mesh.js';
import { Renderer } from './render.js';
import { Game, MISSIONS, SAFEHOUSE } from './game.js';

window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message || e.error)));

const PRESETS = {
  midday: {
    name: 'Midday — scorching sun', sunDir: [0.3, 0.85, 0.25], sunCol: [1.0, 0.95, 0.85],
    amb: [0.55, 0.55, 0.56], fogCol: [0.72, 0.82, 0.92], fogDen: 0.00012, emis: 0.15,
    skyHorizon: [0.62, 0.78, 0.92], skyZenith: [0.25, 0.5, 0.85],
    sun: { az: 0.35, el: 1.05, col: [1.5, 1.35, 0.9], r: 90 }, moon: null, stars: 0,
    head: 0.12, // headlight nearly invisible in daylight
  },
  sunset: {
    name: 'Sunset — golden hour', sunDir: [-0.72, 0.22, -0.3], sunCol: [1.0, 0.55, 0.25],
    amb: [0.42, 0.36, 0.38], fogCol: [0.85, 0.55, 0.35], fogDen: 0.00016, emis: 0.5,
    skyHorizon: [1.0, 0.55, 0.25], skyZenith: [0.35, 0.25, 0.5],
    sun: { az: -1.25, el: 0.16, col: [1.8, 0.9, 0.35], r: 115 }, moon: null, stars: 0,
    head: 0.45,
  },
  night: {
    name: 'Night — moon & stars', sunDir: [0.3, 0.55, -0.4], sunCol: [0.35, 0.42, 0.6],
    amb: [0.22, 0.24, 0.32], fogCol: [0.08, 0.1, 0.18], fogDen: 0.0001, emis: 1.0,
    skyHorizon: [0.1, 0.13, 0.25], skyZenith: [0.02, 0.03, 0.08],
    sun: null, moon: { az: 0.8, el: 0.62, col: [0.9, 0.95, 1.05], r: 55 }, stars: 1,
    head: 1.0,
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
const game = new Game(city, {});

const { mesh: staticMesh } = buildStaticMesh(city);
renderer.setStatic(staticMesh);
renderer.setCars(buildCarMesh(game.cars));

let presetName = 'sunset';
let cam = { x: 1920, y: 7, z: 2080, yaw: 0, pitch: -0.01 };
let camPos = { x: cam.x, y: cam.y, z: cam.z };
let camYawSm = cam.yaw;

const shotName = params.get('shot');
const staticShot = !!(shotName && SHOTS[shotName]);
if (staticShot) {
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
// drive mode: preset from the drive param (day = midday, night = night)
const driveMode = params.get('drive');
if (driveMode === 'day') presetName = 'midday';
if (driveMode === 'night') presetName = 'night';
// haze=off: fog off (headlight pixel test, haze-off variant)
let preset = { ...PRESETS[presetName] };
if (params.get('haze') === 'off') preset = { ...preset, fogDen: 0 };

function applyPreset(name) {
  presetName = name;
  preset = { ...PRESETS[name] };
  if (params.get('haze') === 'off') preset.fogDen = 0;
  renderer.setSky(buildSkyMesh(preset));
  document.getElementById('preset').textContent = preset.name + '  ·  press T to change';
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
let ePressed = false, qPressed = false;
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'e' && !keys['e']) ePressed = true;
  if (k === 'q' && !keys['q']) qPressed = true;
  keys[k] = true;
  if (e.key === '1') applyPreset('midday');
  if (e.key === '2') applyPreset('sunset');
  if (e.key === '3') applyPreset('night');
  if (k === 't') {
    const i = (PRESET_ORDER.indexOf(presetName) + 1) % PRESET_ORDER.length;
    applyPreset(PRESET_ORDER[i]);
  }
  if (k === ' ' || k === 'arrowup' || k === 'arrowdown') e.preventDefault();
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
let dragging = false, lastX = 0, lastY = 0;
let orbitYaw = 0, orbitPitch = 0; // drag offset, eases back to the chase view
canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbitYaw += (e.clientX - lastX) * 0.004;
  orbitPitch -= (e.clientY - lastY) * 0.004;
  orbitPitch = Math.max(-0.5, Math.min(0.5, orbitPitch));
  lastX = e.clientX; lastY = e.clientY;
});

// ---------- test hooks (headless drive / mission screenshots) ----------
// ?drive=day|night: put the player straight into a southbound drivable
// car at speed, mid-boulevard (the chase camera snaps to it at once) —
// the virtual-time headless run only gets a handful of frames, so the
// walk-to-the-car + E + accelerate sequence never gets far enough for a
// drive shot. The autopilot then keeps driving (throttle + lane steer).
// ?etest: Mara on foot beside a drivable car (E prompt + radius ring).
// ?mission=N: teleport Mara to the pickup and start mission N so the
// dialog + HUD panel + world marker all show.
const missionParam = Number(params.get('mission') || 0);
if (missionParam >= 1 && missionParam <= 4) {
  const def = MISSIONS[missionParam - 1];
  game.mara.x = def.pickup.x;
  game.mara.z = def.pickup.z + 12;
  game.mara.yaw = 0;
  game.startMission(missionParam);
}
let headlightOverride = null; // ?headlight=on/off forces the beam (pixel test)
// URL test hooks: ?drive=day|night, ?etest=1, ?mission=N, ?headlight=on|off
// ?shot=name|?cam=x,z, ?haze=off, ?preset=day|sunset|night, ?spawn=x,z,yaw
if (driveMode) {
  // southbound drivable car (yaw PI, x 1930), placed mid-boulevard south
  // so the run ahead is long and clear of the plaza tower/fountain
  const car = game.cars.find((c) => c.kind === 'drivable' && Math.abs(Math.abs(c.yaw) - Math.PI) < 0.01);
  if (car) {
    car.x = 1936; car.z = 2200; car.yaw = Math.PI; car.speed = 15; // 54 km/h
    game.playerCar = car;
    game.inCar = true;
    // snap the chase camera to the car at once (no lerp lag in a short run)
    camPos = { x: car.x - Math.sin(car.yaw) * 10.5, y: 4.6, z: car.z + Math.cos(car.yaw) * 10.5 };
    camYawSm = car.yaw;
    cam.x = camPos.x; cam.y = camPos.y; cam.z = camPos.z; cam.yaw = camYawSm; cam.pitch = -0.10;
  }
}
if (params.get('etest')) {
  const car = game.cars.find((c) => c.kind === 'drivable');
  if (car) {
    game.mara.x = car.x + 4;
    game.mara.z = car.z;
    game.mara.yaw = Math.PI / 2;
    camPos = { x: car.x - 8, y: 4, z: car.z + 9 };
    camYawSm = Math.atan2(car.x - camPos.x, camPos.z - car.z);
    cam.x = camPos.x; cam.y = camPos.y; cam.z = camPos.z; cam.yaw = camYawSm; cam.pitch = -0.08;
  }
}
// ?headlight=on|off (pixel test): night, player car stationary on the
// boulevard facing south, a parked car 20 m ahead inside the beam (the
// headlight range is 30 m, so the car must be closer than that to be lit),
// chase camera snapped behind. on/off changes ONLY the beam, so the same
// pixel patches can be compared between the two shots.
if (params.get('headlight')) {
  const on = params.get('headlight') === 'on';
  applyPreset('night');
  const car = game.cars.find((c) => c.kind === 'drivable' && Math.abs(Math.abs(c.yaw) - Math.PI) < 0.01);
  if (car) {
    car.x = 1936; car.z = 2200; car.yaw = Math.PI; car.speed = 0;
    game.playerCar = car;
    game.inCar = true;
    camPos = { x: 1936, y: 4.6, z: 2189.5 };
    camYawSm = Math.PI;
    cam.x = camPos.x; cam.y = camPos.y; cam.z = camPos.z; cam.yaw = camYawSm; cam.pitch = -0.10;
  }
  const ahead = game.cars.find((c) => c.kind === 'parked');
  if (ahead) { ahead.x = 1936; ahead.z = 2215; ahead.yaw = Math.PI; }
  headlightOverride = on ? 1.0 : 0.0;
}
function autoInput() {
  // autopilot for ?drive: the player starts in the car at speed; keep
  // driving south down the boulevard lane, easing off when a car is ahead
  if (!driveMode) return null;
  const car = game.playerCar;
  if (!car || !game.inCar) return null;
  const tx = 1936, tz = 3000;
  const want = Math.atan2(tx - car.x, car.z - tz);
  let dy = want - car.yaw;
  while (dy > Math.PI) dy -= Math.PI * 2;
  while (dy < -Math.PI) dy += Math.PI * 2;
  const steer = Math.max(-1, Math.min(1, dy * 1.5));
  // ease off if a car is ahead in our lane (within 14 m, lateral < 3)
  let throttle = 0.7;
  const fwd = [Math.sin(car.yaw), -Math.cos(car.yaw)];
  for (const o of game.cars) {
    if (o === car) continue;
    const dx = o.x - car.x, dz = o.z - car.z;
    const along = dx * fwd[0] + dz * fwd[1];
    const lat = Math.abs(dx * fwd[1] - dz * fwd[0]);
    if (along > 0 && along < 14 && lat < 3) { throttle = 0; break; }
  }
  return { throttle, steer, handbrake: false };
}

// ---------- HUD ----------
const elDistrict = document.getElementById('district');
const elTagline = document.getElementById('tagline');
const elStanding = document.getElementById('standing');
const elCompass = document.getElementById('compass');
const elSpeed = document.querySelector('#speedo .num');
const elCash = document.querySelector('#cash .money');
const elDmg = document.querySelector('#cash .dmg b');
const elMission = document.getElementById('mission');
const elDialog = document.getElementById('dialog');
const elPrompt = document.getElementById('prompt');
const elBroadcast = document.getElementById('broadcast');
const mm = document.getElementById('minimap');
const mmCtx = mm.getContext('2d');
const MM_S = 260 / 3840;

function drawMinimap() {
  const g = mmCtx;
  g.fillStyle = '#0d1520';
  g.fillRect(0, 0, 260, 234);
  g.fillStyle = '#2f6f8f';
  g.fillRect(0, 2760 * MM_S, 260, (2916 - 2760) * MM_S);
  g.fillRect(3120 * MM_S, 2376 * MM_S, (3840 - 3120) * MM_S, (3240 - 2376) * MM_S);
  g.fillStyle = '#2f5a2a';
  g.fillRect(2400 * MM_S, 864 * MM_S, 480 * MM_S, 432 * MM_S);
  g.fillStyle = '#c9b078';
  g.fillRect(0, 3240 * MM_S, 260, (3456 - 3240) * MM_S);
  for (const r of city.roads) {
    g.strokeStyle = '#3a3a40';
    g.lineWidth = r.kind === 'boulevard' ? 5 : r.kind === 'cross' ? 4 : r.kind === 'secondary' ? 2.5 : 1.4;
    g.beginPath();
    g.moveTo(r.x1 * MM_S, r.z1 * MM_S);
    g.lineTo(r.x2 * MM_S, r.z2 * MM_S);
    g.stroke();
  }
  for (const b of city.buildings) {
    g.fillStyle = DISTRICTS[b.district].palette[0];
    g.fillRect((b.x - b.w / 2) * MM_S, (b.z - b.d / 2) * MM_S, Math.max(1, b.w * MM_S), Math.max(1, b.d * MM_S));
  }
  g.strokeStyle = '#f2c200';
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(1920 * MM_S, 1728 * MM_S, 130 * MM_S, 0, Math.PI * 2);
  g.stroke();
  // mission target (yellow) + safehouse (pink)
  const t = game.missionTarget();
  if (t) {
    g.fillStyle = '#f2c200';
    g.beginPath(); g.arc(t.x * MM_S, t.z * MM_S, 5, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = '#ff7fb0';
  g.beginPath(); g.arc(SAFEHOUSE.x * MM_S, SAFEHOUSE.z * MM_S, 4, 0, Math.PI * 2); g.fill();
  // player marker (white triangle, rotates with the player yaw)
  const p = game.playerPos();
  g.save();
  g.translate(p.x * MM_S, p.z * MM_S);
  g.rotate(-p.yaw);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(0, -7); g.lineTo(5, 5); g.lineTo(-5, 5); g.closePath();
  g.fill();
  g.restore();
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function updateHUD() {
  const p = game.playerPos();
  const d = DISTRICTS[districtAt(p.x, p.z)];
  elDistrict.textContent = d.name + ' — Solmar';
  elTagline.textContent = '“' + d.tagline + '”';
  elStanding.innerHTML = 'Standing ' + d.standing + '/100<span class="bar"><i style="width:' + d.standing + '%"></i></span>';
  const deg = ((-p.yaw * 180) / Math.PI % 360 + 360) % 360;
  const idx = Math.round(deg / 45) % 8;
  elCompass.innerHTML = POINTS.map((pt, i) => (i === idx ? '<b>' + pt + '</b>' : pt)).join(' · ');
  elSpeed.textContent = String(Math.round(Math.abs(p.speed || 0) * 3.6));
  elCash.textContent = '$' + game.cash.toLocaleString('en-US');
  elDmg.style.width = Math.round(game.damage) + '%';
  // mission panel + dialog (objective in 3 forms: dialog + HUD panel + world marker)
  if (game.mission) {
    const m = game.mission;
    const tgt = game.missionTarget();
    elMission.style.display = 'block';
    elMission.querySelector('.mname').textContent = m.def.id + '. ' + m.def.name + ' — $' + m.def.reward;
    elMission.querySelector('.mstage').textContent = m.stage === 'pickup' ? '▸ Collect' : '▸ Deliver';
    elMission.querySelector('.mtarget').textContent = tgt.label + '  ·  ' + Math.round(Math.hypot(tgt.x - p.x, tgt.z - p.z)) + ' m';
    elMission.querySelector('.mtime').innerHTML = 'Timer <b>' + m.timer.toFixed(1) + 's</b>' + (game.moved ? '' : ' (not running yet)');
    const line = m.stage === 'pickup' ? m.def.dialog[0] : (m.def.dialog[1] || m.def.dialog[0]);
    const who = line.split(':')[0];
    const text = line.slice(who.length + 1).trim();
    elDialog.style.display = 'block';
    elDialog.innerHTML = '<span class="who">' + who + ':</span> ' + text;
  } else {
    elMission.style.display = 'none';
    elDialog.style.display = 'none';
  }
  // E prompt (only on foot, near a car) + the ground radius ring
  if (!game.inCar && game.nearCar) {
    elPrompt.style.display = 'block';
    if (game.nearCar.drivable) {
      elPrompt.className = 'hud';
      elPrompt.innerHTML = 'Press <b>E</b> to enter the car';
    } else {
      elPrompt.className = 'hud locked';
      elPrompt.innerHTML = 'Locked — find a drivable car (gold roof marker)';
    }
  } else {
    elPrompt.style.display = 'none';
  }
  // broadcast (mission 4 finale)
  if (game.broadcast) {
    elBroadcast.style.display = 'block';
    elBroadcast.textContent = 'SOLMAR FM — ' + game.broadcast.text;
  } else {
    elBroadcast.style.display = 'none';
  }
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

function buildInput() {
  const auto = autoInput();
  if (auto) {
    const inp = { throttle: 0, steer: 0, handbrake: false, move: null, shift: false, ePressed: false, qPressed: false };
    if (auto.throttle !== undefined) inp.throttle = auto.throttle;
    if (auto.steer !== undefined) inp.steer = auto.steer;
    if (auto.handbrake !== undefined) inp.handbrake = auto.handbrake;
    if (auto.move) inp.move = auto.move;
    if (auto.shift !== undefined) inp.shift = auto.shift;
    if (auto.ePressed) inp.ePressed = true;
    return inp;
  }
  // player input: W/S throttle (in car) or move (on foot), A/D steer
  const fwd = [Math.sin(camYawSm), -Math.cos(camYawSm)];
  const right = [Math.cos(camYawSm), Math.sin(camYawSm)];
  let mx = 0, mz = 0;
  if (keys['w'] || keys['arrowup']) { mx += fwd[0]; mz += fwd[1]; }
  if (keys['s'] || keys['arrowdown']) { mx -= fwd[0]; mz -= fwd[1]; }
  if (keys['d']) { mx += right[0]; mz += right[1]; }
  if (keys['a']) { mx -= right[0]; mz -= right[1]; }
  const inp = {
    throttle: 0, steer: 0, handbrake: !!keys[' '], move: null,
    shift: !!keys['shift'], ePressed, qPressed,
  };
  if (game.inCar) {
    inp.throttle = (keys['w'] || keys['arrowup'] ? 1 : 0) + (keys['s'] || keys['arrowdown'] ? -1 : 0);
    inp.steer = (keys['d'] ? 1 : 0) + (keys['a'] ? -1 : 0);
  } else if (mx || mz) {
    const l = Math.hypot(mx, mz);
    inp.move = { x: mx / l, z: mz / l };
  }
  return inp;
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const input = buildInput();
  ePressed = false; qPressed = false;
  game.update(dt, input);

  // ---------- camera ----------
  if (!staticShot) {
    const p = game.playerPos();
    // chase: yaw follows the player, drag adds an orbit offset that eases back
    let dy = p.yaw - camYawSm;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    camYawSm += dy * Math.min(1, dt * 4);
    orbitYaw *= Math.max(0, 1 - dt * 1.5);
    orbitPitch *= Math.max(0, 1 - dt * 1.5);
    const cyaw = camYawSm + orbitYaw;
    const dist = p.inCar ? 10.5 : 7;
    const height = p.inCar ? 4.6 : 3.4;
    const tx = p.x - Math.sin(cyaw) * dist;
    const tz = p.z + Math.cos(cyaw) * dist;
    const ty = height;
    const k = 1 - Math.exp(-dt * 6);
    camPos.x += (tx - camPos.x) * k;
    camPos.y += (ty - camPos.y) * k;
    camPos.z += (tz - camPos.z) * k;
    cam.x = camPos.x; cam.z = camPos.z; cam.y = camPos.y;
    cam.yaw = cyaw;
    cam.pitch = -0.10 + orbitPitch;
    // collision shake: a small random jolt scaled by game.shake
    if (game.shake > 0.02) {
      cam.x += (Math.random() - 0.5) * game.shake * 0.7;
      cam.y += (Math.random() - 0.5) * game.shake * 0.5;
    }
  }

  // ---------- dynamic meshes (rebuilt every frame) ----------
  renderer.setCars(buildCarMesh(game.cars));
  renderer.setMara(game.inCar ? { data: new Float32Array(0), count: 0 } : buildMaraMesh(game.mara));
  const markers = [];
  const tgt = game.missionTarget();
  if (tgt) markers.push({ x: tgt.x, z: tgt.z, color: [0.95, 0.76, 0.2], kind: 'mission', y: 9 + Math.sin(now / 350) * 0.5 });
  markers.push({ x: SAFEHOUSE.x, z: SAFEHOUSE.z, color: [1.0, 0.5, 0.7], kind: 'safehouse', y: 9 });
  renderer.setMarkers(buildMarkerMesh(markers, !game.inCar && game.nearCar ? { x: game.nearCar.car.x, z: game.nearCar.car.z } : null));
  // headlight: only the driven car projects a beam + spotlight.
  // headlightOverride (the ?headlight=on|off pixel test) replaces the
  // preset intensity so on/off differ ONLY in the beam.
  const headI = headlightOverride !== null ? headlightOverride : preset.head;
  let head = null;
  if (game.inCar && game.playerCar) {
    const car = game.playerCar;
    const fwd = [Math.sin(car.yaw), -Math.cos(car.yaw)];
    head = {
      pos: [car.x + fwd[0] * 2.2, 0.85, car.z + fwd[1] * 2.2],
      dir: [fwd[0], -0.06, fwd[1]],
      on: headI,
    };
  }
  const beamMarkers = markers.map((m) => ({ x: m.x, z: m.z, color: m.color }));
  renderer.setBeam(buildBeamMesh(head ? { x: head.pos[0], z: head.pos[2], yaw: game.playerCar.yaw, intensity: headI } : null, beamMarkers));

  renderer.draw(cam, preset, head);
  updateHUD();
  frames++;
  if (frames === 3) {
    window.__shotReady = true;
    window.__gameInfo = {
      staticVerts: staticMesh.count,
      carVerts: 0,
      counts: city.counts,
      districtCounts: city.districtCounts,
      inCar: game.inCar,
      cash: game.cash,
      mission: game.mission ? { id: game.mission.def.id, stage: game.mission.stage, timer: game.mission.timer } : null,
      player: game.playerPos(),
    };
    const probe = document.createElement('div');
    probe.id = 'probe';
    probe.setAttribute('data-ready', 'true');
    probe.setAttribute('data-errors', JSON.stringify(window.__errors));
    probe.setAttribute('data-info', JSON.stringify(window.__gameInfo));
    document.body.appendChild(probe);
  }
  if (frames % 30 === 0) {
    // keep the probe fresh so a late --dump-dom still sees live state
    window.__gameInfo = {
      staticVerts: staticMesh.count,
      carVerts: 0,
      counts: city.counts,
      districtCounts: city.districtCounts,
      inCar: game.inCar,
      cash: game.cash,
      mission: game.mission ? { id: game.mission.def.id, stage: game.mission.stage, timer: game.mission.timer } : null,
      player: game.playerPos(),
    };
    const probe = document.getElementById('probe');
    if (probe) probe.setAttribute('data-info', JSON.stringify(window.__gameInfo));
  }
  requestAnimationFrame(frame);
}
document.getElementById('loading').remove();
requestAnimationFrame(frame);
