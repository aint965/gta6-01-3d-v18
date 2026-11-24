// Palkon Auto — Stage B game core: driving, traffic, lights, collision,
// missions. Pure JS (no DOM, no WebGL) so the same code runs in the
// browser (game/src/main.js) and in the Node sim (checks/sim.mjs).
// World: 3840 x 3456, y up. Forward for yaw is [sin(yaw), -cos(yaw)] in (x,z).
import {
  buildCity, districtAt, pointInRect, rectCorners,
  V_STREETS, H_STREETS, WORLD, PLAZA, CANAL, SEED,
} from './city.js';
import { mulberry32 } from './rng.js';

export const PROFILES = {
  compact: { name: 'Compact', topKmh: 115, accel: 11.5, brake: 18, reverseKmh: 30, steer: 2.0 },
  sedan: { name: 'Sedan', topKmh: 130, accel: 12.5, brake: 19, reverseKmh: 32, steer: 1.9 },
  van: { name: 'Van', topKmh: 108, accel: 9.5, brake: 17, reverseKmh: 28, steer: 1.7 },
  coupe: { name: 'Coupe', topKmh: 158, accel: 14.5, brake: 20, reverseKmh: 34, steer: 2.1 },
};
const PROFILE_ORDER = ['compact', 'sedan', 'van', 'coupe', 'sedan', 'compact', 'coupe', 'van'];

// Traffic-light cycle: 26 s. NS green [0,12), yellow [12,16), red [16,26).
// EW is the same function of (phase + 13) % 26, so the two flows never
// share a green.
export const LIGHT_CYCLE = 26;
export function lightPhaseAt(t, offset) {
  return (((t + offset) % LIGHT_CYCLE) + LIGHT_CYCLE) % LIGHT_CYCLE;
}
export function nsStateAt(t, offset) {
  const p = lightPhaseAt(t, offset);
  return p < 12 ? 'green' : p < 16 ? 'yellow' : 'red';
}
// seconds until the NS light turns red (Infinity when already red)
export function nsTimeUntilRed(t, offset) {
  const p = lightPhaseAt(t, offset);
  if (p >= 16) return 0;
  return 16 - p;
}
export function ewStateAt(t, offset) {
  return nsStateAt(t, offset + 13);
}

export const MISSIONS = [
  {
    id: 1, name: 'A Receipt for Sunshine', reward: 250,
    pickup: { x: 1945, z: 1500, label: "Neri's — Market Hall" },
    deliver: { x: 1900, z: 1810, label: 'Oren — Plaza Fountain' },
    dialog: [
      "NERI: Mara — the receipt. Bastion's men missed one copy.",
      "NERI: Take it to Oren at the plaza fountain. Don't stop for anyone.",
    ],
    done: 'Receipt delivered. Oren nods. "Sunshine, accounted for."',
  },
  {
    id: 2, name: 'Salt Ledger', reward: 500,
    pickup: { x: 960, z: 2700, label: 'Canal Warehouse' },
    deliver: { x: 1945, z: 1500, label: "Neri's — Market Hall" },
    dialog: [
      "OREN: The Salt Ledger is in the canal warehouse. Silas wants it burned.",
      'OREN: Bring it to Neri instead. She knows what the numbers mean.',
    ],
    done: 'Ledger delivered. Neri smiles. "Now we know where the salt went."',
  },
  {
    id: 3, name: 'After the Shutters', reward: 450,
    pickup: { x: 1895, z: 1300, label: 'Boulevard Shop' },
    deliver: { x: 3120, z: 2700, label: 'Marina Contact' },
    dialog: [
      "NERI: The shop shutters are down, but the goods are still inside.",
      'NERI: Take the crate to the marina contact. After dark, no questions.',
    ],
    done: 'Crate delivered. The contact melts into the harbour lights.',
  },
  {
    id: 4, name: 'Glass Debt', reward: 800, finale: true,
    pickup: { x: 3300, z: 900, label: 'Glasspoint Tower' },
    deliver: { x: 1900, z: 1650, label: 'Plaza — Silas Rook' },
    dialog: [
      "SILAS ROOK (by phone): The Glass Debt comes due tonight, Mara.",
      'SILAS ROOK: Bring the case to the plaza. Then we are square — or we are not.',
    ],
    done: 'Case delivered. The debt is settled.',
    broadcast: 'SOLMAR FM — BREAKING: The Glass Debt is settled. Mara Venn walks free — for now.',
  },
];

export const SAFEHOUSE = { x: 2420, z: 1000, label: 'Safehouse — Park' };

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
// yaw that faces from (x,z) toward (tx,tz): forward = [sin yaw, -cos yaw]
export function yawTo(x, z, tx, tz) {
  return Math.atan2(tx - x, -(tz - z));
}

// Point-on-road test (grid streets + diagonal avenues + bridges).
export function pointOnRoad(city, px, pz, margin) {
  for (const s of V_STREETS) {
    if (Math.abs(px - s.x) < s.w / 2 + margin) return true;
  }
  for (const s of H_STREETS) {
    if (Math.abs(pz - s.z) < s.w / 2 + margin) return true;
  }
  for (const av of city.diagAvenues) {
    const dx = av.x2 - av.x1, dz = av.z2 - av.z1;
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    const cx = (av.x1 + av.x2) / 2, cz = (av.z1 + av.z2) / 2;
    if (pointInRect(px, pz, cx, cz, av.w + margin * 2, len, yaw)) return true;
  }
  return false;
}

// Static obstacles that are NOT in city.buildings (tower + fountain).
export function buildObstacles() {
  return [
    { kind: 'rect', x: 1920, z: 1728, w: 16, d: 16, yaw: 0, label: 'clock tower' },
    { kind: 'circle', x: 1920, z: 1788, r: 10, label: 'fountain' },
  ];
}

// Traffic-light spots (same as city.js tlSpots, with a per-light phase offset).
export const TL_SPOTS = [
  [1920, 864], [1920, 1296], [1920, 1728], [1920, 2160], [1920, 2592],
  [960, 1728], [1440, 1728], [2400, 1728], [2880, 1728],
  [960, 864], [960, 2592], [2880, 864], [2880, 2592],
];

export class Game {
  constructor(city, opts = {}) {
    this.city = city;
    this.opts = { traffic: opts.traffic !== false, peds: opts.peds !== false };
    // Seeded RNG for traffic turns + pedestrian choices (opts.seed).
    // The sim passes a fixed seed so results are reproducible; the
    // browser omits it and gets Math.random (live traffic every session).
    this.rng = opts.seed !== undefined ? mulberry32(opts.seed) : Math.random;
    this.time = 0; // sim clock (only advances after first move for the mission timer)
    this.rawTime = 0; // wall-clock sim time, always advances
    this.moved = false;
    this.cash = 0;
    this.damage = 0;
    this.shake = 0;
    this.dust = []; // {x,z,y,t,life,size}
    this.broadcast = null; // {text, t}
    this.obstacles = buildObstacles();
    // deep-copy cars with runtime state
    this.cars = city.cars.map((c, i) => ({
      ...c,
      speed: 0,
      profile: c.kind === 'drivable' ? PROFILE_ORDER[i % PROFILE_ORDER.length] : null,
      // traffic runtime
      cruise: 9 + ((i * 37) % 50) / 10, // 9..14 m/s deterministic
      axis: null, streetPos: 0, dir: 0, nextCross: 0, stopped: false,
      stopCount: 0, redRuns: 0, enteredOn: null,
    }));
    this._initTraffic();
    // pedestrians with runtime state
    this.peds = city.pedestrians.map((p, i) => ({
      ...p,
      speed: 1.1 + ((i * 53) % 40) / 100, // 1.1..1.5 m/s
      sw: 0, along: 0, dir: i % 2 === 0 ? 1 : -1,
      state: 'walk', crossFrom: null, crossTo: null, crossT: 0, waitT: 0,
    }));
    this._initPeds();
    // traffic lights
    this.lights = TL_SPOTS.map(([x, z], i) => ({ x, z, offset: i * 3.1 }));
    // player: Mara on foot near the first drivable car
    this.mara = { x: 1896, z: 1872, yaw: yawTo(1896, 1872, 1910, 1860), speed: 0 };
    this.inCar = false;
    this.playerCar = null;
    this.mission = null; // {def, stage:'pickup'|'deliver', timer, dialogIdx}
    this.nearCar = null; // {car, dist, drivable} recomputed each frame
    this.stats = {
      trafficStops: 0, trafficRedRuns: 0, trafficCollisions: 0,
      minFollowGap: Infinity, offRoadTime: 0, playerCollisions: 0,
    };
  }

  // ---------- traffic route setup ----------
  _initTraffic() {
    for (const car of this.cars) {
      if (car.kind !== 'traffic') continue;
      // recover the street the car spawned on: nearest street centre line
      let bestV = null, bestVd = 1e9;
      for (const s of V_STREETS) {
        const d = Math.abs(car.x - s.x);
        if (d < bestVd) { bestVd = d; bestV = s; }
      }
      let bestH = null, bestHd = 1e9;
      for (const s of H_STREETS) {
        const d = Math.abs(car.z - s.z);
        if (d < bestHd) { bestHd = d; bestH = s; }
      }
      if (bestVd <= bestHd) {
        car.axis = 'v';
        car.streetPos = bestV.x;
        car.dir = car.yaw === 0 ? -1 : 1; // yaw 0 = north (-z)
        car.lane = car.x - bestV.x;
      } else {
        car.axis = 'h';
        car.streetPos = bestH.z;
        car.dir = Math.abs(car.yaw - Math.PI / 2) < 0.1 ? 1 : -1; // +x east
        car.lane = car.z - bestH.z;
      }
      car.nextCross = this._nextIntersection(car);
    }
  }

  _crossings(axis, streetPos) {
    // sorted crossing coordinates along an axis street (world edges included)
    if (axis === 'v') return [...H_STREETS.map((s) => s.z), 0, WORLD.h].sort((a, b) => a - b);
    return [...V_STREETS.map((s) => s.x), 0, WORLD.w].sort((a, b) => a - b);
  }

  _nextIntersection(car) {
    const pos = car.axis === 'v' ? car.z : car.x;
    const list = this._crossings(car.axis, car.streetPos);
    if (car.dir > 0) {
      for (const c of list) if (c > pos + 4) return c;
      return list[list.length - 1];
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] < pos - 4) return list[i];
    }
    return list[0];
  }

  _wouldCrossCanal(car, nextCross) {
    // a vertical leg crosses the canal band unless the street is a bridge street
    if (car.axis !== 'v') return false;
    if ([960, 1920, 2880].includes(car.streetPos)) return false;
    const z0 = car.z, z1 = nextCross;
    return (z0 < CANAL.z0 && z1 > CANAL.z1) || (z0 > CANAL.z1 && z1 < CANAL.z0);
  }

  _chooseNextLeg(car) {
    // arrived at an intersection (car.nextCross): pick straight / turn / U-turn
    const atEdge = car.axis === 'v'
      ? (car.nextCross <= 0 || car.nextCross >= WORLD.h)
      : (car.nextCross <= 0 || car.nextCross >= WORLD.w);
    const rnd = this.rng;
    if (atEdge) {
      car.dir = -car.dir; // U-turn
      car.lane = -car.lane;
      car.yaw = car.axis === 'v' ? (car.dir > 0 ? Math.PI : 0) : (car.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      car.nextCross = this._nextIntersection(car);
      return;
    }
    const turn = rnd() < 0.35;
    if (turn) {
      // turn onto the cross street at this intersection — but only if the
      // snap position is clear (never turn into another car)
      const crossPos = car.nextCross;
      const newAxis = car.axis === 'v' ? 'h' : 'v';
      const newDir = rnd() < 0.5 ? 1 : -1;
      const crossStreet = newAxis === 'v'
        ? V_STREETS.find((s) => s.x === crossPos) || null
        : H_STREETS.find((s) => s.z === crossPos) || null;
      const w = crossStreet ? crossStreet.w : 16;
      const newLane = newDir > 0 ? w / 4 : -w / 4;
      const snapX = newAxis === 'v' ? crossPos + newLane : car.x;
      const snapZ = newAxis === 'v' ? car.z : crossPos + newLane;
      let blocked = false;
      for (const o of this.cars) {
        if (o === car || o.kind !== 'traffic') continue;
        if (Math.hypot(o.x - snapX, o.z - snapZ) < 7) { blocked = true; break; }
      }
      if (!blocked) {
        car.axis = newAxis;
        car.streetPos = crossPos;
        car.dir = newDir;
        car.lane = newLane;
        // snap onto the new street centre line (avoids drifting through blocks)
        if (newAxis === 'v') { car.x = crossPos + car.lane; car.yaw = newDir > 0 ? Math.PI : 0; }
        else { car.z = crossPos + car.lane; car.yaw = newDir > 0 ? Math.PI / 2 : -Math.PI / 2; }
        car.nextCross = this._nextIntersection(car);
        return;
      }
      // snap blocked: fall through and continue straight instead
    }
    // straight on — but never cross the canal on a non-bridge street
    if (this._wouldCrossCanal(car, car.nextCross)) {
      car.dir = -car.dir;
      car.lane = -car.lane;
      car.yaw = car.axis === 'v' ? (car.dir > 0 ? Math.PI : 0) : (car.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    }
    car.nextCross = this._nextIntersection(car);
  }

  // ---------- pedestrians ----------
  _initPeds() {
    for (const p of this.peds) {
      // find the sidewalk the pedestrian spawned on (nearest by centre)
      let best = 0, bestD = 1e9;
      this.city.sidewalks.forEach((sw, i) => {
        const d = Math.hypot(p.x - sw.x, p.z - sw.z);
        if (d < bestD) { bestD = d; best = i; }
      });
      p.sw = best;
      const sw = this.city.sidewalks[best];
      // recover the along fraction from the spawn position
      const dx = p.x - sw.x, dz = p.z - sw.z;
      const alongM = dx * Math.sin(sw.yaw) + dz * Math.cos(sw.yaw);
      p.along = clamp(alongM / sw.d, -0.45, 0.45);
    }
  }

  _oppositeSidewalk(swIdx) {
    const sw = this.city.sidewalks[swIdx];
    let best = -1, bestD = 1e9;
    this.city.sidewalks.forEach((o, i) => {
      if (i === swIdx) return;
      // same street segment, opposite side: same length, same centre
      // along the street, mirrored across the road (lateral gap = road
      // width + sidewalk width, 20 m on a local street up to 70 m on
      // the boulevard) — the nearest such strip is the opposite sidewalk
      if (Math.abs(o.d - sw.d) > 1) return;
      const along = (o.x - sw.x) * Math.sin(sw.yaw) + (o.z - sw.z) * Math.cos(sw.yaw);
      const lat = (o.x - sw.x) * Math.cos(sw.yaw) - (o.z - sw.z) * Math.sin(sw.yaw);
      if (Math.abs(along) < 2 && Math.abs(lat) > 3 && Math.abs(lat) < 80) {
        const d = Math.abs(lat);
        if (d < bestD) { bestD = d; best = i; }
      }
    });
    return best;
  }

  _pedPos(p) {
    const sw = this.city.sidewalks[p.sw];
    return {
      x: sw.x + Math.sin(sw.yaw) * p.along * sw.d + Math.cos(sw.yaw) * 0,
      z: sw.z + Math.cos(sw.yaw) * p.along * sw.d - Math.sin(sw.yaw) * 0,
    };
  }

  // ---------- collision ----------
  _carCorners(x, z, yaw, w = 4.4, d = 2.0) {
    return rectCorners(x, z, w, d, yaw);
  }

  // OBB overlap test (separating axis theorem) for two cars.
  // A circle test (d < 5.2) wrongly flags a car passing in the next
  // lane — two cars side by side are 4 m apart centre-to-centre but
  // their long axes make the circle overlap. The OBB test only fires
  // when the two 4.4 x 4.8 m boxes actually intersect.
  _carsOverlap(a, b) {
    const HL = 2.4, HW = 2.2; // half-length (fwd), half-width (right)
    const axes = [];
    for (const c of [a, b]) {
      axes.push([Math.sin(c.yaw), -Math.cos(c.yaw)]); // fwd
      axes.push([Math.cos(c.yaw), Math.sin(c.yaw)]);  // right
    }
    for (const ax of axes) {
      const ca = a.x * ax[0] + a.z * ax[1];
      const cb = b.x * ax[0] + b.z * ax[1];
      const proj = (c) => HL * Math.abs(Math.sin(c.yaw) * ax[0] - Math.cos(c.yaw) * ax[1])
        + HW * Math.abs(Math.cos(c.yaw) * ax[0] + Math.sin(c.yaw) * ax[1]);
      if (Math.abs(ca - cb) >= proj(a) + proj(b)) return false;
    }
    return true;
  }

  _hitsBuilding(x, z, yaw) {
    const corners = this._carCorners(x, z, yaw);
    for (const b of this.city.buildings) {
      if (Math.abs(b.x - x) > 60 || Math.abs(b.z - z) > 60) continue;
      for (const [px, pz] of corners) {
        if (pointInRect(px, pz, b.x, b.z, b.w + 1, b.d + 1, b.yaw)) return b;
      }
      // building corner inside the car rect
      for (const [px, pz] of rectCorners(b.x, b.z, b.w, b.d, b.yaw)) {
        if (pointInRect(px, pz, x, z, 4.4, 2.0, yaw)) return b;
      }
    }
    for (const o of this.obstacles) {
      if (o.kind === 'rect') {
        for (const [px, pz] of corners) {
          if (pointInRect(px, pz, o.x, o.z, o.w, o.d, o.yaw)) return o;
        }
      } else if (Math.hypot(x - o.x, z - o.z) < o.r + 2) {
        return o;
      }
    }
    return null;
  }

  _pointBlocked(x, z, r = 0.5) {
    for (const b of this.city.buildings) {
      if (Math.abs(b.x - x) > 40 || Math.abs(b.z - z) > 40) continue;
      if (pointInRect(x, z, b.x, b.z, b.w + r * 2, b.d + r * 2, b.yaw)) return true;
    }
    for (const o of this.obstacles) {
      if (o.kind === 'rect' && pointInRect(x, z, o.x, o.z, o.w + r * 2, o.d + r * 2, o.yaw)) return true;
      if (o.kind === 'circle' && Math.hypot(x - o.x, z - o.z) < o.r + r) return true;
    }
    return false;
  }

  // ---------- traffic lights ----------
  lightStateFor(lightIdx, axis) {
    const light = this.lights[lightIdx];
    return axis === 'v' ? nsStateAt(this.rawTime, light.offset) : ewStateAt(this.rawTime, light.offset);
  }

  _lightAt(x, z) {
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      if (Math.abs(l.x - x) < 6 && Math.abs(l.z - z) < 6) return i;
    }
    return -1;
  }

  // ---------- main update ----------
  // input: {throttle:-1..1 (W=+1, S=-1), steer:-1..1 (A=-1, D=+1),
  //         handbrake, move:{x,z}|null (on-foot world-space move),
  //         ePressed, qPressed, shift}
  update(dt, input = {}) {
    this.rawTime += dt;
    if (this.broadcast) {
      this.broadcast.t += dt;
      if (this.broadcast.t > 7) this.broadcast = null;
    }
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 1.8);
    for (const d of this.dust) d.t += dt;
    this.dust = this.dust.filter((d) => d.t < d.life);
    const anyInput = (input.throttle && input.throttle !== 0) || (input.steer && input.steer !== 0)
      || input.handbrake || input.move || input.ePressed || input.qPressed;
    if (anyInput) this.moved = true;
    if (this.moved) {
      this.time += dt;
      if (this.mission) this.mission.timer += dt;
    }

    if (this.inCar && this.playerCar) this._updatePlayerCar(dt, input);
    else this._updateMara(dt, input);

    if (input.ePressed) this._pressE();
    if (input.qPressed) this._pressQ();

    if (this.opts.traffic) this._updateTraffic(dt);
    if (this.opts.peds) this._updatePeds(dt);
    this._updateNearCar();
  }

  _updatePlayerCar(dt, input) {
    const car = this.playerCar;
    const prof = PROFILES[car.profile];
    const vmax = (prof.topKmh / 3.6) * (1 - Math.min(this.damage, 100) / 400);
    const v = car.speed;
    let acc = 0;
    const th = input.throttle || 0;
    if (th > 0) {
      acc = prof.accel * Math.min(1, th) * Math.max(0, 1 - v / vmax);
      if (v < 0) acc = prof.brake * Math.min(1, th); // braking while reversing = stop first
    } else if (th < 0) {
      if (v > 0.5) acc = -prof.brake * Math.min(1, -th);
      else acc = -prof.accel * 0.65 * Math.min(1, -th) * Math.max(0, 1 - Math.abs(v) / (prof.reverseKmh / 3.6));
    }
    if (input.handbrake) acc = v > 0 ? -22 : v < 0 ? 22 : 0;
    // gentle rolling drag, only while coasting (never while throttling,
    // or the drag equilibrium sits ~6% below the top speed)
    if (!th && !input.handbrake) acc -= v * 0.05;
    let nv = v + acc * dt;
    if (nv > vmax) nv = vmax;
    const vrev = prof.reverseKmh / 3.6;
    if (nv < -vrev) nv = -vrev;
    if (Math.abs(nv) < 0.05 && !input.throttle) nv = 0;
    // snap to the exact top speed when close (measured top speed must equal target)
    if (input.throttle > 0 && vmax - nv < 0.15) nv = vmax;
    car.speed = nv;
    // steering (rate falls with speed; reverses when reversing)
    const steerF = clamp(Math.abs(nv) / 6, 0, 1) * (1 - 0.4 * Math.min(Math.abs(nv) / vmax, 1));
    const rate = (input.steer || 0) * prof.steer * steerF * (input.handbrake ? 1.5 : 1);
    car.yaw += rate * dt * (nv >= 0 ? 1 : -1);
    // integrate
    const px = car.x, pz = car.z;
    car.x += Math.sin(car.yaw) * nv * dt;
    car.z += -Math.cos(car.yaw) * nv * dt;
    // collision vs buildings / obstacles
    const hit = this._hitsBuilding(car.x, car.z, car.yaw);
    if (hit) {
      car.x = px; car.z = pz;
      const dmg = Math.abs(nv) * 0.8;
      this.damage = Math.min(100, this.damage + dmg);
      this.shake = Math.min(1, 0.35 + Math.abs(nv) / 60);
      this.stats.playerCollisions++;
      this._spawnDust(car.x + Math.sin(car.yaw) * 2.4, car.z - Math.cos(car.yaw) * 2.4, 0.6);
      car.speed = -nv * 0.2;
    }
    // collision vs other cars (OBB overlap — a circle test flags a car
    // passing in the next lane; see _carsOverlap)
    for (const o of this.cars) {
      if (o === car) continue;
      const d = Math.hypot(o.x - car.x, o.z - car.z);
      if (this._carsOverlap(car, o)) {
        const dmg = Math.abs(nv) * 0.5;
        this.damage = Math.min(100, this.damage + dmg);
        this.shake = Math.min(1, 0.3 + Math.abs(nv) / 70);
        this.stats.playerCollisions++;
        this._spawnDust((car.x + o.x) / 2, (car.z + o.z) / 2, 0.8);
        // push apart along the line between the cars (always outward,
        // even when the centres are already > 5.2 m apart — a long car
        // turned across the lane can overlap with distant centres)
        const push = Math.max(0.2, (5.2 - d) / 2);
        const nx = d > 0.01 ? (car.x - o.x) / d : 1, nz = d > 0.01 ? (car.z - o.z) / d : 0;
        car.x += nx * push; car.z += nz * push;
        if (o.kind === 'traffic') { o.x -= nx * push; o.z -= nz * push; }
        car.speed *= 0.4;
      }
    }
    // off-road tracking (player only, for the report)
    if (!pointOnRoad(this.city, car.x, car.z, 0)) this.stats.offRoadTime += dt;
  }

  _updateMara(dt, input) {
    const m = this.mara;
    let mx = 0, mz = 0;
    if (input.move) { mx = input.move.x; mz = input.move.z; }
    const len = Math.hypot(mx, mz);
    if (len > 0) {
      const sp = input.shift ? 9 : 5.5;
      m.speed = sp;
      m.yaw = Math.atan2(mx, -mz);
      const nx = m.x + (mx / len) * sp * dt;
      const nz = m.z + (mz / len) * sp * dt;
      if (!this._pointBlocked(nx, nz, 0.5)) { m.x = nx; m.z = nz; }
      else if (!this._pointBlocked(nx, m.z, 0.5)) { m.x = nx; }
      else if (!this._pointBlocked(m.x, nz, 0.5)) { m.z = nz; }
    } else {
      m.speed = 0;
    }
  }

  _spawnDust(x, z, y) {
    for (let i = 0; i < 5; i++) {
      this.dust.push({
        x: x + (Math.random() - 0.5) * 1.5, z: z + (Math.random() - 0.5) * 1.5,
        y: y + Math.random() * 0.5, t: 0, life: 0.6 + Math.random() * 0.3,
        size: 0.6 + Math.random() * 0.8,
      });
    }
  }

  // ---------- E / Q ----------
  _updateNearCar() {
    const p = this.playerPos();
    let best = null, bestD = 1e9;
    for (const car of this.cars) {
      if (car.kind === 'parked' || car.kind === 'drivable') {
        const d = Math.hypot(car.x - p.x, car.z - p.z);
        if (d < bestD) { bestD = d; best = car; }
      }
    }
    this.nearCar = best && bestD < 7 ? { car: best, dist: bestD, drivable: best.kind === 'drivable' } : null;
  }

  _pressE() {
    if (this.inCar && this.playerCar) {
      // exit: Mara steps out on the car's left side
      const car = this.playerCar;
      const lx = Math.cos(car.yaw), lz = Math.sin(car.yaw);
      let mx = car.x - lx * 3.2, mz = car.z - lz * 3.2;
      if (this._pointBlocked(mx, mz, 0.5)) { mx = car.x + lx * 3.2; mz = car.z + lz * 3.2; }
      this.mara.x = mx; this.mara.z = mz; this.mara.yaw = car.yaw;
      this.inCar = false;
      this.playerCar = null;
      return;
    }
    if (this.nearCar && this.nearCar.drivable) {
      this.playerCar = this.nearCar.car;
      this.inCar = true;
      this.playerCar.speed = 0;
    }
  }

  _pressQ() {
    const p = this.playerPos();
    if (!this.mission) {
      // start a mission by pressing Q near its pickup
      for (const def of MISSIONS) {
        if (Math.hypot(p.x - def.pickup.x, p.z - def.pickup.z) < 9) {
          this.startMission(def.id);
          return;
        }
      }
      return;
    }
    const m = this.mission;
    const target = m.stage === 'pickup' ? m.def.pickup : m.def.deliver;
    if (Math.hypot(p.x - target.x, p.z - target.z) < 9) {
      if (m.stage === 'pickup') {
        m.stage = 'deliver';
        m.dialogIdx = 0;
      } else {
        this.cash += m.def.reward;
        m.done = true;
        if (m.def.finale) {
          this.broadcast = { text: m.def.broadcast, t: 0 };
        }
        this.mission = null;
      }
    }
  }

  startMission(id) {
    const def = MISSIONS.find((m) => m.id === id);
    if (!def) return false;
    this.mission = { def, stage: 'pickup', timer: 0, dialogIdx: 0, done: false };
    return true;
  }

  missionTarget() {
    if (!this.mission) return null;
    const t = this.mission.stage === 'pickup' ? this.mission.def.pickup : this.mission.def.deliver;
    return { ...t, stage: this.mission.stage, name: this.mission.def.name, reward: this.mission.def.reward };
  }

  playerPos() {
    if (this.inCar && this.playerCar) {
      return { x: this.playerCar.x, z: this.playerCar.z, yaw: this.playerCar.yaw, speed: this.playerCar.speed, inCar: true };
    }
    return { x: this.mara.x, z: this.mara.z, yaw: this.mara.yaw, speed: this.mara.speed, inCar: false };
  }

  // ---------- traffic ----------
  _updateTraffic(dt) {
    // follow-gap: for each traffic car, the car ahead in its lane
    for (const car of this.cars) {
      if (car.kind !== 'traffic') continue;
      // desired yaw: face the next intersection (or keep lane direction)
      const pos = car.axis === 'v' ? car.z : car.x;
      const targetYaw = car.axis === 'v' ? (car.dir > 0 ? Math.PI : 0) : (car.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      // gentle steer toward the lane centre line
      const laneErr = car.axis === 'v' ? (car.x - (car.streetPos + car.lane)) : (car.z - (car.streetPos + car.lane));
      const desiredYaw = targetYaw - clamp(laneErr * 0.06, -0.25, 0.25) * (car.dir > 0 ? 1 : -1);
      let dy = angleDiff(desiredYaw, car.yaw);
      car.yaw += clamp(dy, -1.8 * dt, 1.8 * dt);

      // speed target: cruise, limited by lights + follow gap
      let target = car.cruise;
      const distToCross = Math.abs(car.nextCross - pos);
      const li = this._lightAt(car.axis === 'v' ? car.streetPos : car.nextCross, car.axis === 'v' ? car.nextCross : car.streetPos);
      const state = li >= 0 ? this.lightStateFor(li, car.axis) : 'green';
      const stopLineDist = distToCross - 8; // stop with the bumper 8 m before the centre
      if (li >= 0 && stopLineDist > -2 && stopLineDist < 100) {
        // smooth approach: the fastest speed that still stops 4 m short
        // of the line. The 4 m margin (not 2) absorbs the overshoot of a
        // car that was accelerating behind a clearing leader when the
        // light went red — with 2 m it could creep onto the line.
        const vAllow = Math.sqrt(2 * 6 * Math.max(0, stopLineDist - 4));
        if (state === 'red') {
          target = Math.min(target, vAllow);
        } else if (state === 'yellow') {
          // dilemma zone: only proceed if we clearly make it before red
          const off = car.axis === 'v' ? this.lights[li].offset : this.lights[li].offset + 13;
          const tUntilRed = nsTimeUntilRed(this.rawTime, off);
          const tToLine = stopLineDist / Math.max(1, car.speed);
          if (tToLine > Math.max(0, tUntilRed - 0.3)) target = Math.min(target, vAllow);
        }
        // once stopped at the line, count the stop (once per approach)
        if (car.speed < 0.3 && vAllow < 0.8 && !car.stopped) {
          car.stopped = true;
          car.stopCount++;
          this.stats.trafficStops++;
        }
      }
      if (state === 'green' || li < 0) car.stopped = false;
      // intersection yield: at an UNLIT intersection there is no light
      // to separate the flows, so a car approaching the box waits while
      // another car is already inside it. (Only the car already inside
      // proceeds, so two waiters can never deadlock each other.)
      if (li < 0 && distToCross > 10 && distToCross < 30) {
        const cx = car.axis === 'v' ? car.streetPos : car.nextCross;
        const cz = car.axis === 'v' ? car.nextCross : car.streetPos;
        for (const o of this.cars) {
          if (o === car || o.kind !== 'traffic') continue;
          if (Math.abs(o.x - cx) < 10 && Math.abs(o.z - cz) < 10) {
            target = 0;
            break;
          }
        }
      }
      // follow gap: nearest car ahead in the same lane
      let gap = Infinity, leaderSpeed = 0;
      for (const o of this.cars) {
        if (o === car) continue;
        if (o.axis !== car.axis || o.streetPos !== car.streetPos || o.dir !== car.dir) continue;
        const along = car.axis === 'v' ? (o.z - car.z) * car.dir : (o.x - car.x) * car.dir;
        if (along > 0 && along < 30) {
          const g = along - 4.4;
          if (g < gap) { gap = g; leaderSpeed = o.speed || 0; }
        }
      }
      if (gap < Infinity) {
        if (gap < this.stats.minFollowGap) this.stats.minFollowGap = gap;
        // smooth approach: the fastest speed that still stops 3 m behind
        // the leader. The old gap<8 rule braked far too late at 16 m/s —
        // the stopping distance is 21 m — so cars rear-ended a stopped
        // leader and piled up for seconds.
        const vAllow = Math.sqrt(2 * 6 * Math.max(0, gap - 3));
        target = Math.min(target, vAllow);
        if (gap < 3.5) target = 0;
      }
      // integrate speed toward target
      const acc = target > car.speed ? 3.2 : -6;
      car.speed = clamp(car.speed + acc * dt, 0, 16);
      if (target === 0 && car.speed < 0.05) car.speed = 0;
      // move
      const ox = car.x, oz = car.z;
      car.x += Math.sin(car.yaw) * car.speed * dt;
      car.z += -Math.cos(car.yaw) * car.speed * dt;
      // red-run detection: crossed the stop line while red
      if (li >= 0) {
        const before = car.axis === 'v' ? (oz - car.nextCross) * car.dir : (ox - car.nextCross) * car.dir;
        const after = car.axis === 'v' ? (car.z - car.nextCross) * car.dir : (car.x - car.nextCross) * car.dir;
        if (before < -8 && after >= -8) {
          const st = this.lightStateFor(li, car.axis);
          if (st === 'red') {
            car.redRuns++;
            this.stats.trafficRedRuns++;
          }
        }
      }
      // arrived at the intersection?
      const now = car.axis === 'v' ? car.z : car.x;
      if ((car.dir > 0 && now >= car.nextCross - 2) || (car.dir < 0 && now <= car.nextCross + 2)) {
        this._chooseNextLeg(car);
      }
      // keep inside the world (safety net)
      car.x = clamp(car.x, 20, WORLD.w - 20);
      car.z = clamp(car.z, 20, WORLD.h - 20);
    }
    // traffic-vs-traffic collision check (OBB overlap; count only;
    // routes keep them apart)
    const tc = this.cars.filter((c) => c.kind === 'traffic');
    for (let i = 0; i < tc.length; i++) {
      for (let j = i + 1; j < tc.length; j++) {
        if (this._carsOverlap(tc[i], tc[j])) {
          this.stats.trafficCollisions++;
        }
      }
    }
    // separation safety net: never let two traffic cars overlap (the
    // follow-gap metric is measured on the same lanes, so an overlap
    // here would corrupt it)
    for (let i = 0; i < tc.length; i++) {
      for (let j = i + 1; j < tc.length; j++) {
        const dx = tc[j].x - tc[i].x, dz = tc[j].z - tc[i].z;
        const d = Math.hypot(dx, dz);
        if (this._carsOverlap(tc[i], tc[j])) {
          const push = Math.max(0.2, (4.8 - d) / 2);
          const nx = d > 0.01 ? dx / d : 1, nz = d > 0.01 ? dz / d : 0;
          tc[i].x -= nx * push; tc[i].z -= nz * push;
          tc[j].x += nx * push; tc[j].z += nz * push;
          tc[j].speed = Math.min(tc[j].speed, tc[i].speed);
        }
      }
    }
  }

  // ---------- pedestrians ----------
  _updatePeds(dt) {
    for (const p of this.peds) {
      const sw = this.city.sidewalks[p.sw];
      if (p.state === 'walk') {
        p.along += p.dir * p.speed * dt / sw.d;
        if (p.along >= 0.45 || p.along <= -0.45) {
          p.along = clamp(p.along, -0.45, 0.45);
          // 35% cross to the opposite sidewalk (if the road is clear), else turn back
          const opp = this._oppositeSidewalk(p.sw);
          if (opp >= 0 && this.rng() < 0.35) {
            const pos = this._pedPos(p);
            const osw = this.city.sidewalks[opp];
            const tpos = {
              x: osw.x + Math.sin(osw.yaw) * p.along * osw.d,
              z: osw.z + Math.cos(osw.yaw) * p.along * osw.d,
            };
            const mid = { x: (pos.x + tpos.x) / 2, z: (pos.z + tpos.z) / 2 };
            let clear = true;
            for (const c of this.cars) {
              if (Math.hypot(c.x - mid.x, c.z - mid.z) < 12) { clear = false; break; }
            }
            if (clear) {
              p.state = 'cross';
              p.crossFrom = { ...pos };
              p.crossTo = { ...tpos, sw: opp, along: p.along };
              p.crossT = 0;
              continue;
            }
          }
          p.dir = -p.dir;
        }
        p.yaw = sw.yaw + (p.dir > 0 ? 0 : Math.PI);
      } else if (p.state === 'cross') {
        p.crossT += dt;
        const total = Math.hypot(p.crossTo.x - p.crossFrom.x, p.crossTo.z - p.crossFrom.z) / 1.4;
        const t = clamp(p.crossT / Math.max(0.1, total), 0, 1);
        p.x = p.crossFrom.x + (p.crossTo.x - p.crossFrom.x) * t;
        p.z = p.crossFrom.z + (p.crossTo.z - p.crossFrom.z) * t;
        p.yaw = yawTo(p.crossFrom.x, p.crossFrom.z, p.crossTo.x, p.crossTo.z);
        if (t >= 1) {
          p.sw = p.crossTo.sw;
          p.along = p.crossTo.along;
          p.state = 'walk';
          p.dir = this.rng() < 0.5 ? 1 : -1;
        }
      }
    }
  }

  // ---------- render lists (for main.js) ----------
  carList() {
    return this.cars;
  }

  pedList() {
    const out = [];
    for (const p of this.peds) {
      if (p.state === 'cross') {
        out.push({ x: p.x, z: p.z, yaw: p.yaw, jacket: p.jacket });
      } else {
        const pos = this._pedPos(p);
        out.push({ x: pos.x, z: pos.z, yaw: p.yaw, jacket: p.jacket });
      }
    }
    if (!this.inCar) {
      out.push({ x: this.mara.x, z: this.mara.z, yaw: this.mara.yaw, jacket: '#e0785a', mara: true });
    }
    return out;
  }

  lightStates() {
    return this.lights.map((l, i) => ({
      x: l.x, z: l.z,
      ns: nsStateAt(this.rawTime, l.offset),
      ew: ewStateAt(this.rawTime, l.offset),
      face: this.city.trafficLights[i] ? this.city.trafficLights[i].face : 0,
    }));
  }
}
