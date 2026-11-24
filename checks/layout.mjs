// Layout verifier for Solmar (Stage A). Pure Node, imports the same city.js
// the browser game uses. Exits non-zero on any problem.
import { buildCity, districtAt, pointInRect, rectCorners, SEED, PLAZA, CANAL, V_STREETS, H_STREETS, SIDEWALK_W } from '../game/src/city.js';

const city = buildCity(SEED);
const problems = [];
const notes = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

const c = city.counts;
console.log(`city seed=${city.seed} buildings=${c.buildings} trees=${c.trees} lamps=${c.lamps} ` +
  `trafficLights=${c.trafficLights} cars=${c.cars} (parked=${c.parked} drivable=${c.drivable} traffic=${c.traffic}) ` +
  `pedestrians=${c.pedestrians} boats=${c.boats} sidewalks=${c.sidewalks} cornerPads=${c.cornerPads} bridges=${c.bridges}`);
console.log('districts:', JSON.stringify(city.districtCounts));

// ---------- counts ----------
check(c.buildings >= 500, `too few buildings: ${c.buildings} < 500`);
check(c.parked >= 40, `too few parked cars: ${c.parked} < 40`);
check(c.drivable === 8, `drivable cars must be 8, got ${c.drivable}`);
check(c.traffic >= 30, `too few traffic cars: ${c.traffic} < 30`);
check(c.trees >= 150, `too few trees: ${c.trees} < 150`);
check(c.lamps >= 100, `too few lamps: ${c.lamps} < 100`);
check(c.trafficLights === 13, `traffic lights must be 13, got ${c.trafficLights}`);
check(c.boats >= 5, `too few boats: ${c.boats} < 5`);
check(c.pedestrians === 40, `pedestrians must be 40, got ${c.pedestrians}`);
check(c.bridges === 3, `bridges must be 3, got ${c.bridges}`);
for (const id of Object.keys(city.districts)) {
  check((city.districtCounts[id] || 0) >= 5, `district ${id} has only ${city.districtCounts[id] || 0} buildings`);
}

// ---------- plaza clear ----------
for (const b of city.buildings) {
  if (Math.hypot(b.x - PLAZA.x, b.z - PLAZA.z) < 150) {
    problems.push(`building at (${b.x.toFixed(0)},${b.z.toFixed(0)}) inside the plaza (r=150)`);
  }
}

// ---------- buildings off roads ----------
function roadRects() {
  const rects = [];
  for (const s of V_STREETS) {
    rects.push({ x: s.x, z: 1728, w: s.w, d: 3456, yaw: 0 });
  }
  for (const s of H_STREETS) {
    rects.push({ x: 1920, z: s.z, w: 3840, d: s.w, yaw: 0 });
  }
  for (const av of city.diagAvenues) {
    const dx = av.x2 - av.x1, dz = av.z2 - av.z1;
    rects.push({
      x: (av.x1 + av.x2) / 2, z: (av.z1 + av.z2) / 2,
      w: av.w, d: Math.hypot(dx, dz), yaw: Math.atan2(dx, dz),
    });
  }
  return rects;
}
const rects = roadRects();
let roadHits = 0;
for (const b of city.buildings) {
  const corners = rectCorners(b.x, b.z, b.w, b.d, b.yaw);
  for (const [px, pz] of corners) {
    for (const r of rects) {
      if (pointInRect(px, pz, r.x, r.z, r.w + 2, r.d + 2, r.yaw)) {
        roadHits++;
        if (roadHits <= 5) problems.push(`building at (${b.x.toFixed(0)},${b.z.toFixed(0)}) corner on a road`);
        break;
      }
    }
    if (roadHits > 0) break;
  }
}

// ---------- cars not inside buildings ----------
let carHits = 0;
for (const car of city.cars) {
  for (const b of city.buildings) {
    if (pointInRect(car.x, car.z, b.x, b.z, b.w + 2, b.d + 2, b.yaw)) {
      carHits++;
      if (carHits <= 5) problems.push(`car (${car.kind}) at (${car.x.toFixed(0)},${car.z.toFixed(0)}) inside a building`);
      break;
    }
  }
}

// ---------- pedestrians on sidewalks ----------
let pedOff = 0;
for (const p of city.pedestrians) {
  let on = false;
  for (const sw of city.sidewalks) {
    if (pointInRect(p.x, p.z, sw.x, sw.z, sw.w + 1, sw.d + 1, sw.yaw)) { on = true; break; }
  }
  if (!on) {
    for (const pad of city.cornerPads) {
      if (Math.abs(p.x - pad.x) <= pad.s / 2 + 0.5 && Math.abs(p.z - pad.z) <= pad.s / 2 + 0.5) { on = true; break; }
    }
  }
  if (!on) pedOff++;
}
check(pedOff === 0, `${pedOff} pedestrians are not on a sidewalk`);

// ---------- sidewalk coverage along the boulevard (both sides, every segment) ----------
let missing = 0;
const hEdges = [0, ...H_STREETS.map((s) => s.z), 3456];
for (let j = 0; j < hEdges.length - 1; j++) {
  const z0 = hEdges[j] === 0 ? 0 : hEdges[j] + (H_STREETS[j - 1]?.w ?? 0) / 2;
  const z1 = hEdges[j + 1] === 3456 ? 3456 : hEdges[j + 1] - (H_STREETS[j]?.w ?? 0) / 2;
  if (z1 - z0 < 20) continue;
  if (z0 < CANAL.z1 && z1 > CANAL.z0) continue; // canal band: promenade + bridge walkways
  for (const side of [-1, 1]) {
    const ex = 1920 + side * (64 / 2 + SIDEWALK_W.boulevard / 2);
    const ez = (z0 + z1) / 2;
    const found = city.sidewalks.some((sw) =>
      Math.abs(sw.x - ex) < 1 && Math.abs(sw.z - ez) < 1 && Math.abs(sw.d - (z1 - z0)) < 1);
    if (!found) {
      missing++;
      if (missing <= 5) problems.push(`missing boulevard sidewalk x=${ex} z=${z0.toFixed(0)}..${z1.toFixed(0)}`);
    }
  }
}
check(missing === 0, `${missing} boulevard sidewalk segments missing`);

// ---------- bridge walkways over the canal ----------
for (const bx of [960, 1920, 2880]) {
  for (const side of [-1, 1]) {
    const s = V_STREETS.find((v) => v.x === bx);
    const ex = bx + side * (s.w / 2 + 2.5);
    const found = city.sidewalks.some((sw) => Math.abs(sw.x - ex) < 1 && Math.abs(sw.z - (CANAL.z0 + CANAL.z1) / 2) < 1);
    check(found, `missing bridge walkway at x=${ex}`);
  }
}

// ---------- facade sanity: every building has a wall colour + a front face ----------
for (const b of city.buildings) {
  if (!b.wall || b.wall.length !== 3) { problems.push(`building at (${b.x},${b.z}) has no wall colour`); break; }
  if (!['front', 'back', 'left', 'right'].includes(b.frontFace)) { problems.push(`building at (${b.x},${b.z}) has bad frontFace`); break; }
}

console.log(`problems: ${problems.length}`);
for (const p of problems) console.log('  FAIL ' + p);
for (const n of notes) console.log('  note ' + n);
if (problems.length > 0) {
  console.log('LAYOUT: FAIL');
  process.exit(1);
}
console.log('LAYOUT: 0 problems');
