// Stage B sim (Node, no browser): driving profiles, traffic, lights,
// collision, missions. Imports the same game.js the browser uses.
// Usage: node checks/sim.mjs
import { buildCity, SEED, V_STREETS, H_STREETS, pointInRect } from '../game/src/city.js';
import { Game, PROFILES, MISSIONS, nsStateAt, LIGHT_CYCLE } from '../game/src/game.js';

const DT = 1 / 60;
const results = [];
const fails = [];
function check(ok, label, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails.push(label);
}
function kmh(ms) { return ms * 3.6; }

function freshGame(opts = {}) {
  const city = buildCity(SEED);
  // fixed traffic seed: the sim must be reproducible run to run
  return new Game(city, { ...opts, seed: 20261123 });
}

// ---------- autopilot: Manhattan routing on the street grid ----------
// Waypoints use left-hand lanes (like the traffic): a northbound leg on
// the boulevard runs at x=1904, which clears the clock tower (1912..1928)
// and the fountain (1910..1930); the street-centre route would ram them.
function routeTo(game, from, to) {
  const vStreet = [...V_STREETS].sort((a, b) => Math.abs(a.x - from.x) - Math.abs(b.x - from.x))[0];
  const hStreet = [...H_STREETS].sort((a, b) => Math.abs(a.z - to.z) - Math.abs(b.z - to.z))[0];
  const goingNorth = to.z < from.z;
  const goingEast = to.x > vStreet.x;
  const laneV = goingNorth ? -vStreet.w / 4 : vStreet.w / 4; // left-hand lanes
  const laneH = goingEast ? -hStreet.w / 4 : hStreet.w / 4;
  const wps = [];
  // 1. pull into the correct lane on the vertical street, at the current z.
  // (A diagonal straight to the far waypoint would cut the corner and
  // clip the fountain/tower on the boulevard centre line.)
  wps.push({ x: vStreet.x + laneV, z: from.z });
  // 2. drive along the vertical street (in-lane) to the horizontal street
  wps.push({ x: vStreet.x + laneV, z: hStreet.z });
  // 2b. continue along the vertical lane to the horizontal LANE (not the
  // street centre). Without this the vertical->horizontal leg is a
  // diagonal through the intersection — at the boulevard x cross avenue
  // that diagonal cuts straight through the clock tower (1920,1728),
  // and the car wedges on its corner for the whole leg (dmg 100).
  wps.push({ x: vStreet.x + laneV, z: hStreet.z + laneH });
  // 3. drive along the horizontal street (in-lane) to the target's x
  wps.push({ x: to.x, z: hStreet.z + laneH });
  // 4. drive to the target
  wps.push({ x: to.x, z: to.z });
  // drop waypoints already within 12 m, except the lane-entry (index 0)
  // and the final target
  return wps.filter((w, i) => i === 0 || i === wps.length - 1 || Math.hypot(w.x - from.x, w.z - from.z) > 12);
}

// The traffic light on the intersection the player is driving toward
// (if any): returns {lightIdx, stopLineDist, axis} or null.
function lightAhead(game, p) {
  const fwd = [Math.sin(p.yaw), -Math.cos(p.yaw)];
  const vertical = Math.abs(fwd[1]) > 0.7;
  if (vertical) {
    const street = [...V_STREETS].sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0];
    if (Math.abs(p.x - street.x) > street.w / 2 + 12) return null;
    const dir = fwd[1] < 0 ? -1 : 1; // north = -z
    let next = null;
    for (const hs of H_STREETS) {
      if (dir < 0 && hs.z < p.z - 4 && (next === null || hs.z > next)) next = hs.z;
      if (dir > 0 && hs.z > p.z + 4 && (next === null || hs.z < next)) next = hs.z;
    }
    if (next === null) return null;
    const li = game.lights.findIndex((l) => Math.abs(l.x - street.x) < 6 && Math.abs(l.z - next) < 6);
    if (li < 0) return null;
    return { lightIdx: li, stopLineDist: Math.abs(p.z - next) - 8, axis: 'v' };
  }
  const street = [...H_STREETS].sort((a, b) => Math.abs(a.z - p.z) - Math.abs(b.z - p.z))[0];
  if (Math.abs(p.z - street.z) > street.w / 2 + 12) return null;
  const dir = fwd[0] > 0 ? 1 : -1; // east = +x
  let next = null;
  for (const vs of V_STREETS) {
    if (dir > 0 && vs.x > p.x + 4 && (next === null || vs.x < next)) next = vs.x;
    if (dir < 0 && vs.x < p.x - 4 && (next === null || vs.x > next)) next = vs.x;
  }
  if (next === null) return null;
  const li = game.lights.findIndex((l) => Math.abs(l.x - next) < 6 && Math.abs(l.z - street.z) < 6);
  if (li < 0) return null;
  return { lightIdx: li, stopLineDist: Math.abs(p.x - next) - 8, axis: 'h' };
}

function driveLeg(game, target, timeoutS, opts = {}) {
  // returns {reached, time, maxSpeed, minGapToLight}
  const wps = routeTo(game, game.playerPos(), target);
  const startPos = { x: game.playerPos().x, z: game.playerPos().z };
  let wi = 0;
  let stuckT = 0, lastDist = 1e9, reverseT = 0;
  let blockedT = 0, detourUntil = -1, detourSide = 1;
  let maxSpeed = 0;
  let nearFinalT = 0;
  const steps = Math.ceil(timeoutS / DT);
  for (let s = 0; s < steps; s++) {
    const p = game.playerPos();
    maxSpeed = Math.max(maxSpeed, Math.abs(p.speed || 0));
    const wp = wps[Math.min(wi, wps.length - 1)];
    const d = Math.hypot(wp.x - p.x, wp.z - p.z);
    if (d < 9) {
      if (wi >= wps.length - 1) return { reached: true, time: s * DT, maxSpeed };
      wi++;
      continue;
    }
    // close to the final target but not arriving: creep straight at it
    const finalD = Math.hypot(target.x - p.x, target.z - p.z);
    if (wi >= wps.length - 1 && finalD < 25) {
      nearFinalT += DT;
      if (nearFinalT > 8) {
        // direct creep: ignore waypoints, crawl at the target
        const dy = Math.atan2(target.x - p.x, -(target.z - p.z)) - p.yaw;
        let dyy = dy;
        while (dyy > Math.PI) dyy -= Math.PI * 2;
        while (dyy < -Math.PI) dyy += Math.PI * 2;
        game.update(DT, { throttle: 0.3, steer: Math.max(-1, Math.min(1, dyy * 1.6)) });
        if (finalD < 8) return { reached: true, time: s * DT, maxSpeed };
        continue;
      }
    } else {
      nearFinalT = 0;
    }
    // car ahead? brake with the distance the speed actually needs.
    // (A 13 m lookahead is far too short at 115 km/h — the stopping
    // distance is 27 m — so the car rear-ended the car ahead.)
    let carAhead = false;
    let carAheadBrake = 0;
    let nearestLatS = 0, nearestAlong = Infinity;
    for (const c of game.cars) {
      if (c === game.playerCar) continue;
      const dx = c.x - p.x, dz = c.z - p.z;
      const fwd = [Math.sin(p.yaw), -Math.cos(p.yaw)];
      const along = dx * fwd[0] + dz * fwd[1];
      const lat = Math.abs(dx * fwd[1] - dz * fwd[0]);
      // along > -5 (not > 0): a car we already rear-ended and now overlap
      // sits at along ≈ 0 — it must still count as "ahead", or the car
      // grinds against it forever (carAhead false, detour never triggers)
      if (along > -5 && along < 40 && lat < 3) {
        carAhead = true;
        if (along < nearestAlong) { nearestAlong = along; nearestLatS = dx * fwd[1] - dz * fwd[0]; }
        const gap = Math.max(0.05, along - 6); // stop 6 m behind it
        const need = (p.speed * p.speed) / (2 * gap);
        carAheadBrake = Math.max(carAheadBrake, Math.max(0.05, Math.min(1, need / 19)));
      }
    }
    // red light ahead? brake so we stop 4 m short of the line (centre).
    // The braking distance is the REAL distance (no 1 m clamp): clamping
    // it made the last metre's brake far too weak and the car coasted
    // over the line at ~2 m/s. No 0.25 floor either: a floor stops the
    // car 80+ m early when it is far from the line.
    let lightBrake = 0; // 0 = no brake, else throttle magnitude (0.05..1)
    let handbrake = false;
    const la = lightAhead(game, p);
    if (la && la.stopLineDist > 0 && la.stopLineDist < 100) {
      const st = game.lightStateFor(la.lightIdx, la.axis);
      if (st === 'red' || st === 'yellow') {
        const eff = Math.max(0.05, la.stopLineDist - 4);
        if (p.speed < 1.5 && eff < 5) {
          // final stop: Space stops dead and never reverses. (Releasing
          // the brake below 0.5 m/s leaves the car creeping on rolling
          // drag for ~20 s, so the stop is never registered.)
          handbrake = true;
        } else {
          const need = (p.speed * p.speed) / (2 * eff);
          lightBrake = Math.max(0.05, Math.min(1, need / 19));
        }
      }
    }
    // blocked behind a car that never moves (parked / jammed)? go around
    // it: shift the leg line sideways for 4 s. (Without this the car
    // waited 170 s behind a parked drivable car — carAhead also disables
    // the stuck-recovery, so it never escaped on its own.)
    if (carAhead && p.speed < 0.5 && !lightBrake && !handbrake) blockedT += DT;
    else blockedT = 0;
    if (blockedT > 4 && s >= detourUntil) {
      detourSide = nearestLatS >= 0 ? -1 : 1; // pass on the far side
      detourUntil = s + Math.ceil(4 / DT);
      blockedT = 0;
    }
    const detouring = s < detourUntil;
    // LINE-FOLLOWING steering: steer onto the leg line (prev waypoint ->
    // current waypoint), not just at the far waypoint. Pure pursuit to a
    // waypoint 300 m away gives a ~0.02 rad steer for a 6 m lateral
    // error — the car never gets into its lane before the fountain
    // (1920,1788) on the boulevard centre line. Following the line
    // pulls the car into the lane within a second.
    let ls = wi === 0 ? startPos : wps[wi - 1];
    let legWp = wp;
    if (detouring) {
      // shift the whole leg line sideways (perpendicular, left = (dz, -dx))
      const legDx0 = wp.x - ls.x, legDz0 = wp.z - ls.z;
      const legLen0 = Math.hypot(legDx0, legDz0) || 1;
      const perpX = legDz0 / legLen0, perpZ = -legDx0 / legLen0;
      const sh = detourSide * 10;
      ls = { x: ls.x + perpX * sh, z: ls.z + perpZ * sh };
      legWp = { x: wp.x + perpX * sh, z: wp.z + perpZ * sh };
    }
    const legDx = legWp.x - ls.x, legDz = legWp.z - ls.z;
    const legLen = Math.hypot(legDx, legDz) || 1;
    const legDirX = legDx / legLen, legDirZ = legDz / legLen;
    const relX = p.x - ls.x, relZ = p.z - ls.z;
    const alongLeg = Math.max(0, Math.min(legLen, relX * legDirX + relZ * legDirZ));
    const closestX = ls.x + legDirX * alongLeg, closestZ = ls.z + legDirZ * alongLeg;
    const toLineX = closestX - p.x, toLineZ = closestZ - p.z;
    const toLineD = Math.hypot(toLineX, toLineZ);
    const pull = Math.min(1, toLineD * 0.15);
    const desX = legDirX + (toLineD > 0.01 ? (toLineX / toLineD) * pull : 0);
    const desZ = legDirZ + (toLineD > 0.01 ? (toLineZ / toLineD) * pull : 0);
    const desiredYaw = Math.atan2(desX, -desZ);
    let dy = desiredYaw - p.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    let throttle = 1;
    if (handbrake) throttle = 0;
    else if (detouring) throttle = 0.5; // power past the obstacle on the shifted line
    else if (carAhead) throttle = p.speed > 0.5 ? -carAheadBrake : 0;
    else if (lightBrake > 0) throttle = p.speed > 0.5 ? -lightBrake : 0;
    // brake BEFORE a sharp turn when fast, or the car swings wide off
    // its lane (it entered this leg at 114 km/h and clipped a parked car)
    else if (Math.abs(dy) > 1.0) throttle = p.speed > 10 ? -0.5 : 0.35;
    else if (d < 25) throttle = 0.5;
    const input = { throttle, steer: Math.max(-1, Math.min(1, dy * 2.0)), handbrake };
    if (reverseT > 0) {
      input.throttle = -1;
      input.steer = -input.steer;
      input.handbrake = false;
      reverseT -= DT;
    }
    game.update(DT, input);
    // stuck detection — never while intentionally stopped (light / car ahead)
    if (carAhead || lightBrake > 0 || handbrake) stuckT = 0;
    else if (Math.abs(d - lastDist) < 0.02 && throttle > 0) stuckT += DT;
    else stuckT = 0;
    lastDist = d;
    if (stuckT > 2.5) { reverseT = 1.2; stuckT = 0; }
  }
  const p = game.playerPos();
  return { reached: Math.hypot(target.x - p.x, target.z - p.z) < 10, time: timeoutS, maxSpeed };
}

// ---------- 1. top speeds ----------
console.log('== top speeds (clear boulevard straight, traffic off) ==');
for (const key of Object.keys(PROFILES)) {
  const game = freshGame({ traffic: false, peds: false });
  const car = game.cars.find((c) => c.kind === 'drivable' && c.profile === key);
  game.playerCar = car;
  game.inCar = true;
  car.x = 1900; car.z = 3300; car.yaw = 0; car.speed = 0;
  let top = 0;
  for (let s = 0; s < 30 / DT; s++) {
    game.update(DT, { throttle: 1, steer: 0 });
    top = Math.max(top, car.speed);
    if (car.z < 300) break; // end of the straight
  }
  const got = kmh(top);
  const want = PROFILES[key].topKmh;
  console.log(`  ${key}: ${got.toFixed(1)} km/h (target ${want}) collisions=${game.stats.playerCollisions}`);
  check(Math.abs(got - want) < 1.0, `top speed ${key}`, `${got.toFixed(1)} vs ${want}`);
  check(game.stats.playerCollisions === 0, `top speed ${key} 0 collisions`, `${game.stats.playerCollisions}`);
}

// ---------- 2. reverse ----------
{
  const game = freshGame({ traffic: false, peds: false });
  const car = game.cars.find((c) => c.kind === 'drivable' && c.profile === 'sedan');
  game.playerCar = car;
  game.inCar = true;
  car.x = 1900; car.z = 2000; car.yaw = 0; car.speed = 0;
  const z0 = car.z;
  for (let s = 0; s < 2.5 / DT; s++) game.update(DT, { throttle: -1, steer: 0 });
  const dist = car.z - z0; // reversing north (yaw 0) moves +z
  console.log(`== reverse: ${dist.toFixed(1)} m in 2.5 s (sedan) ==`);
  check(dist > 8 && dist < 25, 'reverse distance', `${dist.toFixed(1)} m`);
}

// ---------- 3. red-light stop (player car) ----------
{
  const game = freshGame({ traffic: false, peds: false });
  const car = game.cars.find((c) => c.kind === 'drivable' && c.profile === 'sedan');
  game.playerCar = car;
  game.inCar = true;
  car.x = 1900; car.z = 1900; car.yaw = 0; car.speed = 0;
  // set the clock so the NS light at (1920,1728) is red on arrival (~7 s)
  // light idx 2, offset 6.2; want phase in [18,22] at t=7 -> rawTime = 20-6.2-7 = 6.8
  game.rawTime = 6.8;
  const arrivalPhase = ((6.8 + 7 + 6.2) % LIGHT_CYCLE);
  console.log(`== red light: NS phase on arrival ${arrivalPhase.toFixed(1)} (${nsStateAt(6.8 + 7, 6.2)}) ==`);
  // drive straight north in the west lane (x=1904 clears the tower);
  // lightAhead() finds the (1920,1728) light on the boulevard
  let stopped = false;
  for (let s = 0; s < 25 / DT; s++) {
    const p = game.playerPos();
    const la = lightAhead(game, p);
    let throttle = 1;
    let handbrake = false;
    if (la && la.stopLineDist > 0 && la.stopLineDist < 100) {
      const st = game.lightStateFor(la.lightIdx, la.axis);
      if (st === 'red' || st === 'yellow') {
        // stop 4 m short of the line (centre); real distance, no clamp, no floor
        const eff = Math.max(0.05, la.stopLineDist - 4);
        if (p.speed < 1.5 && eff < 5) {
          handbrake = true; throttle = 0; // final stop: dead stop, no creep
        } else {
          const need = (p.speed * p.speed) / (2 * eff);
          throttle = p.speed > 0.5 ? -Math.max(0.05, Math.min(1, need / 19)) : 0;
        }
      }
    }
    // hold the west lane (x=1904): steer toward the lane line, not a
    // far point — a far-point pursuit is too gentle to correct 4 m
    const laneYaw = -Math.max(-0.5, Math.min(0.5, (p.x - 1904) * 0.1));
    let dyy = laneYaw - p.yaw;
    while (dyy > Math.PI) dyy -= Math.PI * 2;
    while (dyy < -Math.PI) dyy += Math.PI * 2;
    game.update(DT, { throttle, steer: Math.max(-1, Math.min(1, dyy * 1.6)), handbrake });
    if (Math.abs(p.speed) < 0.05 && la && la.stopLineDist < 25) { stopped = true; break; }
  }
  const frontZ = car.z - 2.2; // facing north, front bumper
  const gap = frontZ - 1736; // stop line is 8 m south of the intersection centre (1728)
  console.log(`  stopped=${stopped} at z=${car.z.toFixed(1)}, front gap to stop line: ${gap.toFixed(1)} m`);
  check(stopped, 'red-light car stopped');
  check(gap >= 0.5 && gap <= 15, 'red-light stop gap', `${gap.toFixed(1)} m`);
  check(game.stats.playerCollisions === 0, 'red-light run 0 collisions');
}

// ---------- 4. traffic 90 s ----------
{
  const game = freshGame({ traffic: true, peds: true });
  const t0 = Date.now();
  let offRoadFrames = 0, frames = 0;
  for (let s = 0; s < 90 / DT; s++) {
    game.update(DT, {});
    frames++;
    // sample every 10th frame: are traffic cars on roads?
    if (s % 10 === 0) {
      for (const c of game.cars) {
        if (c.kind !== 'traffic') continue;
        let on = false;
        for (const vs of V_STREETS) if (Math.abs(c.x - vs.x) < vs.w / 2 + 2) { on = true; break; }
        if (!on) for (const hs of H_STREETS) if (Math.abs(c.z - hs.z) < hs.w / 2 + 2) { on = true; break; }
        if (!on) offRoadFrames++;
      }
    }
  }
  const st = game.stats;
  console.log(`== traffic 90 s: stops=${st.trafficStops} red-runs=${st.trafficRedRuns} minFollowGap=${st.minFollowGap === Infinity ? 'n/a' : st.minFollowGap.toFixed(1) + ' m'} collisions=${st.trafficCollisions} offRoadSamples=${offRoadFrames} (wall ${(Date.now() - t0) / 1000}s) ==`);
  check(st.trafficStops >= 4, 'traffic stops at red', `${st.trafficStops}`);
  check(st.trafficRedRuns === 0, 'traffic 0 red-runs', `${st.trafficRedRuns}`);
  check(st.minFollowGap >= 2.0 || st.minFollowGap === Infinity, 'min follow gap >= 2.0 m', `${st.minFollowGap.toFixed(1)} m`);
  check(st.trafficCollisions === 0, 'traffic 0 collisions', `${st.trafficCollisions}`);
}

// ---------- 5. collisions ----------
{
  // building: aim at a REAL building east of the boulevard — the old
  // spawn (1900,1500) threaded the 4 m gap between the block's south
  // face and the H street and hit nothing in 3 s
  const game = freshGame({ traffic: false, peds: false });
  const car = game.cars.find((c) => c.kind === 'drivable' && c.profile === 'sedan');
  game.playerCar = car;
  game.inCar = true;
  const parkedZ = [];
  for (let k = 0; k < 45; k++) parkedZ.push(200 + 78 * k);
  const candidates = game.city.buildings
    .filter((bb) => bb.yaw === 0 && bb.x - bb.w / 2 > 1952 && bb.x - bb.w / 2 < 2020)
    .filter((bb) => Math.abs(bb.z - 1788) > 15 && Math.abs(bb.z - 1728) > 15) // not the fountain/tower line
    .filter((bb) => parkedZ.every((pz) => Math.abs(bb.z - pz) > 10)) // clear of parked cars
    .sort((a, b) => (a.x - a.w / 2) - (b.x - b.w / 2));
  const target = candidates[0];
  car.x = 1900; car.z = target.z; car.yaw = Math.PI / 2; car.speed = 25; // east, at the building
  const dmg0 = game.damage;
  let hitAt = -1;
  for (let s = 0; s < 8 / DT; s++) {
    game.update(DT, { throttle: 1, steer: 0 });
    if (game.damage > dmg0 + 1) { hitAt = s * DT; break; }
  }
  console.log(`== building hit: damage ${dmg0} -> ${game.damage.toFixed(1)}, speed ${kmh(car.speed).toFixed(1)} km/h, shake=${game.shake.toFixed(2)}, dust=${game.dust.length}, hit at ${hitAt >= 0 ? hitAt.toFixed(1) + 's' : 'never'} (west face ${target.x - target.w / 2}, z=${target.z}) ==`);
  check(game.damage > 10, 'building collision damage', `${game.damage.toFixed(1)}`);
  check(game.stats.playerCollisions > 0, 'building collision counted');
  check(game.shake > 0 || game.dust.length > 0, 'collision feedback (shake/dust)');
  // car vs car
  const game2 = freshGame({ traffic: false, peds: false });
  const car2 = game2.cars.find((c) => c.kind === 'drivable' && c.profile === 'sedan');
  game2.playerCar = car2;
  game2.inCar = true;
  const parked = game2.cars.find((c) => c.kind === 'parked');
  car2.x = parked.x - 30; car2.z = parked.z; car2.yaw = Math.PI / 2; car2.speed = 0;
  for (let s = 0; s < 4 / DT; s++) game2.update(DT, { throttle: 1, steer: 0 });
  console.log(`== car hit: damage ${game2.damage.toFixed(1)}, collisions=${game2.stats.playerCollisions} ==`);
  check(game2.damage > 0, 'car-vs-car damage', `${game2.damage.toFixed(1)}`);
}

// ---------- 6. mission timer does not run before the player moves ----------
{
  const game = freshGame({ traffic: true, peds: true });
  game.startMission(1);
  for (let s = 0; s < 5 / DT; s++) game.update(DT, {});
  const t0 = game.mission.timer;
  game.update(DT, { throttle: 1, steer: 0 });
  const t1 = game.mission.timer;
  console.log(`== mission timer: ${t0.toFixed(2)} s after 5 s idle, ${t1.toFixed(2)} s after first move ==`);
  check(t0 === 0, 'mission timer 0 before move', `${t0}`);
  check(t1 > 0, 'mission timer runs after move', `${t1.toFixed(2)}`);
}

// ---------- 7. missions 1-4 playthrough (autopilot) ----------
{
  const game = freshGame({ traffic: true, peds: true });
  // enter the nearest drivable car first
  const car = game.cars.find((c) => c.kind === 'drivable' && c.profile === 'compact');
  game.playerCar = car;
  game.inCar = true;
  car.x = 1910; car.z = 1860; car.yaw = 0; car.speed = 0;
  // Mara starts next to it; put the player in the car directly for the sim
  let expectedCash = 0;
  for (const def of MISSIONS) {
    game.startMission(def.id);
    const leg1 = driveLeg(game, def.pickup, 180);
    game.update(DT, { qPressed: true });
    const picked = game.mission && game.mission.stage === 'deliver';
    const leg2 = driveLeg(game, def.deliver, 180);
    game.update(DT, { qPressed: true });
    expectedCash += def.reward;
    const ok = game.cash === expectedCash;
    console.log(`== mission ${def.id} ${def.name}: pickup reached=${leg1.reached} (${leg1.time.toFixed(0)}s) picked=${picked} deliver reached=${leg2.reached} (${leg2.time.toFixed(0)}s) cash=$${game.cash} (expect $${expectedCash}) ==`);
    check(leg1.reached, `mission ${def.id} reach pickup`);
    check(picked, `mission ${def.id} collect`);
    check(leg2.reached, `mission ${def.id} reach deliver`);
    check(ok, `mission ${def.id} cash`, `$${game.cash} vs $${expectedCash}`);
  }
  console.log(`== missions total: $${game.cash} (clean-play target $2,000), broadcast=${game.broadcast ? 'YES' : 'no'} ==`);
  check(game.cash === 2000, 'missions total $2,000', `$${game.cash}`);
  check(!!game.broadcast, 'mission 4 broadcast moment', game.broadcast ? game.broadcast.text : 'none');
  // 3 forms of the objective: dialog lines + HUD data + world marker target
  const g2 = freshGame({ traffic: false, peds: false });
  g2.startMission(1);
  const tgt = g2.missionTarget();
  check(!!tgt && !!tgt.label, 'mission world marker target', tgt ? tgt.label : 'none');
  check(g2.mission.def.dialog.length >= 2, 'mission dialog lines', `${g2.mission.def.dialog.length}`);
}

// ---------- 8. pedestrians ----------
{
  const game = freshGame({ traffic: true, peds: true });
  for (let s = 0; s < 30 / DT; s++) game.update(DT, {});
  const walking = game.peds.filter((p) => p.state === 'walk').length;
  const crossing = game.peds.filter((p) => p.state === 'cross').length;
  let offSw = 0;
  for (const p of game.peds) {
    if (p.state !== 'walk') continue;
    const pos = game._pedPos(p);
    let on = false;
    for (const sw of game.city.sidewalks) {
      if (pointInRect(pos.x, pos.z, sw.x, sw.z, sw.w + 1, sw.d + 1, sw.yaw)) { on = true; break; }
    }
    if (!on) offSw++;
  }
  console.log(`== pedestrians after 30 s: walking=${walking} crossing=${crossing} off-sidewalk=${offSw} ==`);
  check(walking >= 20, 'pedestrians walking >= 20', `${walking}`);
  check(offSw === 0, 'pedestrians on sidewalks', `${offSw} off`);
}

console.log(`\nSIM: ${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
for (const r of results) console.log('  ' + r);
if (fails.length > 0) {
  console.log(`SIM: FAIL (${fails.length})`);
  process.exit(1);
}
console.log('SIM: ALL PASS');
