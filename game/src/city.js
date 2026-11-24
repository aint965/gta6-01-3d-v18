// Solmar city data — pure generation, no DOM, no WebGL. Deterministic (seed 20261123).
// World: 3840 x 3456, centre (1920, 1728). Units are metres, y is up.
import { mulberry32, pick, range, rangeInt, chance } from './rng.js';

export const WORLD = { w: 3840, h: 3456, cx: 1920, cz: 1728 };
export const SEED = 20261123;
export const PLAZA = { x: 1920, z: 1728, r: 130 };
export const CANAL = { z0: 2760, z1: 2916 }; // east-west water band, replaces the z=2808 street row
export const PARK = { x0: 2400, x1: 2880, z0: 864, z1: 1296 };

export const DISTRICTS = {
  old: {
    id: 'old', name: 'Old Solmar', tagline: 'Streets older than the map.', standing: 72,
    palette: ['#c9a06a', '#b98a5e', '#d9b98a', '#a87a52'],
    roof: ['#8a6a48', '#7a5a3c', '#96684a'],
  },
  canal: {
    id: 'canal', name: 'Canal Ward', tagline: 'Salt, rope, and low bridges.', standing: 64,
    palette: ['#a85f4a', '#96543f', '#c07a5a', '#7a4a3a'],
    roof: ['#6e4030', '#5d3628', '#7d4a38'],
  },
  market: {
    id: 'market', name: 'South Market', tagline: 'Everything is for sale, twice.', standing: 81,
    palette: ['#d77f69', '#c96a55', '#e09a7a', '#b85a48'],
    roof: ['#8a4a3a', '#7a4034', '#96604a'],
  },
  citrus: {
    id: 'citrus', name: 'Citrus Quarter', tagline: 'Sun in the walls, lemons on the sills.', standing: 77,
    palette: ['#e8d9a8', '#ead8b2', '#dcc98f', '#f0e3c0'],
    roof: ['#a88a58', '#96783f', '#b09a68'],
  },
  marina: {
    id: 'marina', name: 'Pearl Marina', tagline: 'Boats that never leave.', standing: 69,
    palette: ['#e8e4da', '#dfe8e4', '#cfd8d2', '#f2efe8'],
    roof: ['#7a8a86', '#6a7a76', '#8a9a94'],
  },
  glass: {
    id: 'glass', name: 'Glasspoint', tagline: 'The city, reflected.', standing: 58,
    palette: ['#7fa8b8', '#6f9aa8', '#8fb8c8'],
    roof: ['#4a6a78', '#3e5a68', '#56707c'],
    glass: true,
  },
  beach: {
    id: 'beach', name: 'Sunstrand Beach', tagline: 'Sand in every pocket.', standing: 85,
    palette: ['#e8d5a8', '#dfc89a', '#efe0b8'],
    roof: ['#b08a58', '#a07a48', '#c09a68'],
  },
};

export function districtAt(x, z) {
  if (z > 3240) return 'beach';
  // marina: the waterfront strip facing the harbour (water cells themselves
  // are skipped, so this is the row of buildings along the harbour edge)
  if (x > 2880 && z >= 2160 && z <= 3240) return 'marina';
  if (z >= 2592 && z <= 3240 && x <= 2880) return 'canal';
  if (x > 2880 && z < 1728) return 'glass';
  if (x < 1200 && z > 2160) return 'old';
  if (z < 864) return 'citrus';
  return 'market';
}

// Vertical streets (x, width, kind). Boulevard 1920 w=64, secondaries 960/2880 w=28.
export const V_STREETS = [
  { x: 240, w: 16, kind: 'local' }, { x: 480, w: 16, kind: 'local' },
  { x: 720, w: 16, kind: 'local' }, { x: 960, w: 28, kind: 'secondary' },
  { x: 1200, w: 16, kind: 'local' }, { x: 1440, w: 16, kind: 'local' },
  { x: 1680, w: 16, kind: 'local' }, { x: 1920, w: 64, kind: 'boulevard' },
  { x: 2160, w: 16, kind: 'local' }, { x: 2400, w: 16, kind: 'local' },
  { x: 2640, w: 16, kind: 'local' }, { x: 2880, w: 28, kind: 'secondary' },
  { x: 3120, w: 16, kind: 'local' }, { x: 3360, w: 16, kind: 'local' },
  { x: 3600, w: 16, kind: 'local' },
];
// Horizontal streets (z, width, kind). Cross avenue 1728 w=48, secondaries 864/2592 w=28.
// The z=2808 row is replaced by the canal.
export const H_STREETS = [
  { z: 216, w: 16, kind: 'local' }, { z: 432, w: 16, kind: 'local' },
  { z: 648, w: 16, kind: 'local' }, { z: 864, w: 28, kind: 'secondary' },
  { z: 1080, w: 16, kind: 'local' }, { z: 1296, w: 16, kind: 'local' },
  { z: 1512, w: 16, kind: 'local' }, { z: 1728, w: 48, kind: 'cross' },
  { z: 1944, w: 16, kind: 'local' }, { z: 2160, w: 16, kind: 'local' },
  { z: 2376, w: 16, kind: 'local' }, { z: 2592, w: 28, kind: 'secondary' },
  { z: 3024, w: 16, kind: 'local' }, { z: 3240, w: 16, kind: 'local' },
];

export const SIDEWALK_W = { boulevard: 6, cross: 6, secondary: 5, local: 4 };
export const BRIDGES = [960, 1920, 2880]; // vertical streets with a deck over the canal

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function shade(rgb, f) {
  return [Math.min(1, rgb[0] * f), Math.min(1, rgb[1] * f), Math.min(1, rgb[2] * f)];
}

export function buildCity(seed = SEED) {
  const rnd = mulberry32(seed);
  const city = {
    seed,
    districts: DISTRICTS,
    vStreets: V_STREETS,
    hStreets: H_STREETS,
    buildings: [],
    roads: [], // {x1,z1,x2,z2,w,kind,y} axis-aligned or diagonal road quads
    sidewalks: [], // {x,z,w,d,yaw} raised strips, y handled by mesh
    cornerPads: [], // {x,z,s} square pads at major intersections
    trees: [], // {x,z,s,kind}
    lamps: [], // {x,z}
    trafficLights: [], // {x,z,face,state}
    cars: [], // {x,z,yaw,kind:'parked'|'drivable'|'traffic',color}
    pedestrians: [], // {x,z,yaw,jacket}
    boats: [], // {x,z,yaw}
    signs: [], // {x,y,z,yaw,w,h,slot} neon landmark signs (slot into atlas)
    bridges: [], // {x,z0,z1,w}
    plaza: PLAZA,
    canal: CANAL,
    park: PARK,
  };

  // ---------- roads ----------
  for (const s of V_STREETS) {
    const w = s.w;
    // split at the canal; bridge streets get a deck instead of a gap
    city.roads.push({ x1: s.x, z1: 0, x2: s.x, z2: CANAL.z0, w, kind: s.kind, y: 0.12 });
    city.roads.push({ x1: s.x, z1: CANAL.z1, x2: s.x, z2: WORLD.h, w, kind: s.kind, y: 0.12 });
    if (BRIDGES.includes(s.x)) {
      city.bridges.push({ x: s.x, z0: CANAL.z0 - 20, z1: CANAL.z1 + 20, w: w + 4 });
    }
  }
  for (const s of H_STREETS) {
    city.roads.push({ x1: 0, z1: s.z, x2: WORLD.w, z2: s.z, w: s.w, kind: s.kind, y: 0.12 });
  }
  // Old Solmar diagonal avenues (off-grid)
  const diagA = { x1: 80, z1: 3050, x2: 1180, z2: 2320, w: 20, kind: 'old', y: 0.12 };
  const diagB = { x1: 150, z1: 3380, x2: 1150, z2: 2950, w: 16, kind: 'old', y: 0.12 };
  city.roads.push(diagA, diagB);
  city.diagAvenues = [diagA, diagB];

  // point-on-road test (grid streets + diagonal avenues), used to keep
  // diagonal buildings, scattered trees and traffic clear of the roads.
  function pointOnRoad(px, pz, margin) {
    for (const s of V_STREETS) {
      if (Math.abs(px - s.x) < s.w / 2 + margin) return true;
    }
    for (const s of H_STREETS) {
      if (Math.abs(pz - s.z) < s.w / 2 + margin) return true;
    }
    for (const av of [diagA, diagB]) {
      const dx = av.x2 - av.x1, dz = av.z2 - av.z1;
      const len = Math.hypot(dx, dz);
      const yaw = Math.atan2(dx, dz);
      const cx = (av.x1 + av.x2) / 2, cz = (av.z1 + av.z2) / 2;
      if (pointInRectLocal(px, pz, cx, cz, av.w + margin * 2, len, yaw)) return true;
    }
    return false;
  }
  function pointInRectLocal(px, pz, x, z, w, d, yaw) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const dx = px - x, dz = pz - z;
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    return Math.abs(lx) <= w / 2 && Math.abs(lz) <= d / 2;
  }

  // ---------- sidewalks ----------
  const vEdges = [0, ...V_STREETS.map((s) => s.x), WORLD.w];
  const hEdges = [0, ...H_STREETS.map((s) => s.z), WORLD.h];
  // vertical strips: between consecutive horizontal streets
  for (const s of V_STREETS) {
    const sw = SIDEWALK_W[s.kind];
    for (let j = 0; j < hEdges.length - 1; j++) {
      const z0 = hEdges[j] === 0 ? 0 : hEdges[j] + (H_STREETS[j - 1]?.w ?? 0) / 2;
      const z1 = hEdges[j + 1] === WORLD.h ? WORLD.h : hEdges[j + 1] - (H_STREETS[j]?.w ?? 0) / 2;
      if (z1 - z0 < 20) continue;
      // skip the canal band (promenade handled separately)
      if (z0 < CANAL.z1 && z1 > CANAL.z0) continue;
      for (const side of [-1, 1]) {
        city.sidewalks.push({
          x: s.x + side * (s.w / 2 + sw / 2),
          z: (z0 + z1) / 2,
          w: sw, d: z1 - z0, yaw: 0,
        });
      }
    }
  }
  // horizontal strips: between consecutive vertical streets
  for (const s of H_STREETS) {
    const sw = SIDEWALK_W[s.kind];
    for (let i = 0; i < vEdges.length - 1; i++) {
      const x0 = vEdges[i] === 0 ? 0 : vEdges[i] + (V_STREETS[i - 1]?.w ?? 0) / 2;
      const x1 = vEdges[i + 1] === WORLD.w ? WORLD.w : vEdges[i + 1] - (V_STREETS[i]?.w ?? 0) / 2;
      if (x1 - x0 < 20) continue;
      for (const side of [-1, 1]) {
        city.sidewalks.push({
          x: (x0 + x1) / 2,
          z: s.z + side * (s.w / 2 + sw / 2),
          w: sw, d: x1 - x0, yaw: Math.PI / 2, // local +Z runs along X
        });
      }
    }
  }
  // corner pads at major intersections (boulevard / cross / secondary)
  const majorV = V_STREETS.filter((s) => s.kind !== 'local');
  const majorH = H_STREETS.filter((s) => s.kind !== 'local');
  for (const vs of V_STREETS) {
    for (const hs of H_STREETS) {
      if (vs.kind === 'local' && hs.kind === 'local') continue;
      const sw = Math.max(SIDEWALK_W[vs.kind], SIDEWALK_W[hs.kind]);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          city.cornerPads.push({
            x: vs.x + sx * (vs.w / 2 + sw / 2),
            z: hs.z + sz * (hs.w / 2 + sw / 2),
            s: sw,
          });
        }
      }
    }
  }
  // diagonal avenue sidewalks (rotated strips)
  for (const av of [diagA, diagB]) {
    const dx = av.x2 - av.x1, dz = av.z2 - av.z1;
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz); // rotation so local +Z runs along the avenue
    const nx = dz / len, nz = -dx / len; // perpendicular
    for (const side of [-1, 1]) {
      city.sidewalks.push({
        x: (av.x1 + av.x2) / 2 + side * nx * (av.w / 2 + 2),
        z: (av.z1 + av.z2) / 2 + side * nz * (av.w / 2 + 2),
        w: 4, d: len, yaw,
      });
    }
  }
  void majorV; void majorH;

  // ---------- buildings ----------
  function addBuilding(b) {
    city.buildings.push(b);
  }
  function buildingHeight(districtId, x, z) {
    const distC = Math.hypot(x - WORLD.cx, z - WORLD.cz);
    const falloff = 1 - 0.35 * Math.min(1, distC / 2600);
    let base;
    switch (districtId) {
      case 'glass': base = range(rnd, 26, 56); break;
      case 'market': base = range(rnd, 14, 34); break;
      case 'citrus': base = range(rnd, 10, 22); break;
      case 'old': base = range(rnd, 8, 16); break;
      case 'canal': base = range(rnd, 10, 20); break;
      case 'marina': base = range(rnd, 8, 16); break;
      case 'beach': base = range(rnd, 4, 8); break;
      default: base = range(rnd, 10, 20);
    }
    if (Math.abs(x - 1920) < 220) base *= 1.35; // tallest along the boulevard
    return Math.max(4, Math.round(base * falloff));
  }
  function makeBuilding(x, z, w, d, yaw, districtId) {
    const dist = DISTRICTS[districtId];
    const wallHex = pick(rnd, dist.palette);
    const roofHex = pick(rnd, dist.roof);
    const h = buildingHeight(districtId, x, z);
    const shop = districtId !== 'beach' && Math.abs(x - 1920) < 260 && chance(rnd, 0.7);
    return {
      x, z, w, d, h, yaw, district: districtId,
      wall: hexRgb(wallHex), roof: hexRgb(roofHex),
      glass: !!dist.glass,
      shop,
      sign: shop && chance(rnd, 0.5) ? rangeInt(rnd, 0, 7) : null,
      frontFace: 'front',
      floors: Math.max(1, Math.round(h / 3)),
    };
  }

  // grid blocks
  for (let i = 0; i < vEdges.length - 1; i++) {
    for (let j = 0; j < hEdges.length - 1; j++) {
      const x0 = vEdges[i] === 0 ? 24 : vEdges[i] + (V_STREETS[i - 1]?.w ?? 0) / 2;
      const x1 = vEdges[i + 1] === WORLD.w ? WORLD.w - 24 : vEdges[i + 1] - (V_STREETS[i]?.w ?? 0) / 2;
      const z0 = hEdges[j] === 0 ? 24 : hEdges[j] + (H_STREETS[j - 1]?.w ?? 0) / 2;
      const z1 = hEdges[j + 1] === WORLD.h ? WORLD.h - 24 : hEdges[j + 1] - (H_STREETS[j]?.w ?? 0) / 2;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      // exclusions
      if (Math.hypot(cx - PLAZA.x, cz - PLAZA.z) < 190) continue; // plaza
      if (z0 < CANAL.z1 + 6 && z1 > CANAL.z0 - 6) continue; // canal band
      if (x0 > 3120 && z0 > 2376 && z1 < 3240) continue; // harbour water
      if (x0 >= PARK.x0 && x1 <= PARK.x1 && z0 >= PARK.z0 && z1 <= PARK.z1) continue; // park
      if (cx < 1200 && cz > 2160) continue; // Old Solmar: diagonal placement below
      const bw = x1 - x0 - 14, bd = z1 - z0 - 14;
      if (bw < 14 || bd < 14) continue;
      const districtId = districtAt(cx, cz);
      const nx = bw > 170 ? rangeInt(rnd, 2, 3) : bw > 90 ? rangeInt(rnd, 1, 2) : 1;
      const nz = bd > 150 ? rangeInt(rnd, 1, 2) : 1;
      const lotW = bw / nx, lotD = bd / nz;
      for (let a = 0; a < nx; a++) {
        for (let b = 0; b < nz; b++) {
          if (chance(rnd, 0.08)) continue; // occasional courtyard gap
          const gap = range(rnd, 3, 6);
          const w = Math.max(9, lotW - gap - range(rnd, 0, 6));
          const d = Math.max(9, lotD - gap - range(rnd, 0, 6));
          const bx = x0 + 7 + a * lotW + lotW / 2 + range(rnd, -2, 2);
          const bz = z0 + 7 + b * lotD + lotD / 2 + range(rnd, -2, 2);
          const bdng = makeBuilding(bx, bz, w, d, 0, districtId);
          // front face: toward the nearer street
          const dWest = Math.abs(bx - (vEdges[i] + (V_STREETS[i - 1]?.w ?? 0) / 2));
          const dEast = Math.abs(bx - (vEdges[i + 1] - (V_STREETS[i]?.w ?? 0) / 2));
          const dNorth = Math.abs(bz - (hEdges[j] + (H_STREETS[j - 1]?.w ?? 0) / 2));
          const dSouth = Math.abs(bz - (hEdges[j + 1] - (H_STREETS[j]?.w ?? 0) / 2));
          const m = Math.min(dWest, dEast, dNorth, dSouth);
          bdng.frontFace = m === dWest ? 'left' : m === dEast ? 'right' : m === dNorth ? 'back' : 'front';
          addBuilding(bdng);
        }
      }
    }
  }
  // Old Solmar diagonal buildings (rotated, along the two avenues)
  for (const av of [diagA, diagB]) {
    const dx = av.x2 - av.x1, dz = av.z2 - av.z1;
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    const nx = dz / len, nz = -dx / len;
    const n = Math.floor(len / 62);
    for (let k = 0; k < n; k++) {
      for (const side of [-1, 1]) {
        if (chance(rnd, 0.18)) continue;
        const t = (k + 0.5) / n;
        const px = av.x1 + dx * t + side * nx * (av.w / 2 + 15 + range(rnd, 0, 6));
        const pz = av.z1 + dz * t + side * nz * (av.w / 2 + 15 + range(rnd, 0, 6));
        if (px < 40 || px > 1180 || pz < 2200 || pz > 3420) continue;
        const w = range(rnd, 14, 24), d = range(rnd, 12, 20);
        // keep the rotated building off the grid roads it crosses
        const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([lx, lz]) => {
          const c = Math.cos(yaw), s = Math.sin(yaw);
          return [px + lx * c + lz * s, pz - lx * s + lz * c];
        });
        if (corners.some(([cx2, cz2]) => pointOnRoad(cx2, cz2, 1)) || pointOnRoad(px, pz, 1)) continue;
        addBuilding(makeBuilding(px, pz, w, d, yaw, 'old'));
      }
    }
  }

  // bridge-deck sidewalks (walkways over the canal)
  for (const bx of BRIDGES) {
    const s = V_STREETS.find((v) => v.x === bx);
    for (const side of [-1, 1]) {
      city.sidewalks.push({
        x: bx + side * (s.w / 2 + 2.5),
        z: (CANAL.z0 + CANAL.z1) / 2,
        w: 5, d: CANAL.z1 - CANAL.z0 + 40, yaw: 0,
      });
    }
  }

  // ---------- trees ----------
  function addTree(x, z, kind = 'leaf') {
    city.trees.push({ x, z, s: range(rnd, 0.85, 1.3), kind });
  }
  for (let z = 120; z < WORLD.h; z += 96) { // boulevard rows
    if (Math.abs(z - 1728) < 90 || (z > CANAL.z0 - 60 && z < CANAL.z1 + 60)) continue;
    addTree(1920 - 36, z + range(rnd, -14, 14));
    addTree(1920 + 36, z + range(rnd, -14, 14));
  }
  for (let i = 0; i < 34; i++) { // park
    addTree(range(rnd, PARK.x0 + 16, PARK.x1 - 16), range(rnd, PARK.z0 + 16, PARK.z1 - 16));
  }
  for (let x = 300; x < 3800; x += 90) { // canal promenade, north bank
    addTree(x + range(rnd, -16, 16), CANAL.z0 - 14);
    if (chance(rnd, 0.6)) addTree(x + range(rnd, -16, 16), CANAL.z1 + 14);
  }
  for (let x = 200; x < 3800; x += 150) { // beach palms
    if (chance(rnd, 0.75)) addTree(x + range(rnd, -20, 20), range(rnd, 3300, 3420), 'palm');
  }
  for (let i = 0; i < 46; i++) { // scattered block trees (never on a road)
    const tx = range(rnd, 120, 3720), tz = range(rnd, 120, 3200);
    if (pointOnRoad(tx, tz, 2)) continue;
    addTree(tx, tz);
  }

  // ---------- lamps ----------
  function addLamp(x, z) { city.lamps.push({ x, z }); }
  for (let z = 80; z < WORLD.h; z += 110) {
    if (Math.abs(z - 1728) < 60 || (z > CANAL.z0 - 40 && z < CANAL.z1 + 40)) continue;
    addLamp(1920 - 35, z);
    addLamp(1920 + 35, z + 55);
  }
  for (let x = 120; x < WORLD.w; x += 130) {
    addLamp(x, 1728 - 27);
    addLamp(x + 65, 1728 + 27);
  }
  for (const sx of [960, 2880]) {
    for (let z = 100; z < WORLD.h; z += 260) {
      if (z > CANAL.z0 - 40 && z < CANAL.z1 + 40) continue;
      addLamp(sx + 17, z);
    }
  }
  for (const sz of [864, 2592]) {
    for (let x = 140; x < WORLD.w; x += 260) addLamp(x, sz + 17);
  }
  for (let a = 0; a < 8; a++) { // plaza ring
    const t = (a / 8) * Math.PI * 2;
    addLamp(PLAZA.x + Math.cos(t) * 118, PLAZA.z + Math.sin(t) * 118);
  }
  for (let x = 400; x < 3700; x += 320) addLamp(x, CANAL.z0 - 12); // promenade

  // ---------- traffic lights ----------
  const tlSpots = [
    [1920, 864], [1920, 1296], [1920, 1728], [1920, 2160], [1920, 2592],
    [960, 1728], [1440, 1728], [2400, 1728], [2880, 1728],
    [960, 864], [960, 2592], [2880, 864], [2880, 2592],
  ];
  tlSpots.forEach(([x, z], i) => {
    city.trafficLights.push({ x, z, face: i % 2 === 0 ? 0 : Math.PI / 2, state: i % 3 === 0 ? 'red' : 'green' });
  });

  // ---------- cars ----------
  const CAR_COLORS = ['#c0392b', '#2e6da4', '#d8d8d8', '#222831', '#7a4a8a', '#b07a2a', '#3a7a5a'];
  function addCar(x, z, yaw, kind, color) {
    city.cars.push({ x, z, yaw, kind, color });
  }
  for (let z = 200; z < WORLD.h; z += 78) { // parked along the boulevard
    if (Math.abs(z - 1728) < 140 || (z > CANAL.z0 - 50 && z < CANAL.z1 + 50)) continue;
    if (chance(rnd, 0.85)) addCar(1920 - 27, z, 0, 'parked', pick(rnd, CAR_COLORS));
    if (chance(rnd, 0.6)) addCar(1920 + 27, z + 39, Math.PI, 'parked', pick(rnd, CAR_COLORS));
  }
  for (const sx of [960, 2880]) {
    for (let z = 300; z < WORLD.h; z += 260) {
      if (z > CANAL.z0 - 50 && z < CANAL.z1 + 50) continue;
      addCar(sx - 11, z, 0, 'parked', pick(rnd, CAR_COLORS));
    }
  }
  for (let i = 0; i < 8; i++) { // drivable, near spawn on the boulevard
    addCar(1920 - 10 + (i % 2) * 20, 1860 + i * 34, i % 2 === 0 ? 0 : Math.PI, 'drivable', pick(rnd, CAR_COLORS));
  }
  for (let i = 0; i < 40; i++) { // traffic, static in Stage A, on road lanes
    const vertical = chance(rnd, 0.5);
    let tx, tz, tyaw;
    if (vertical) {
      const s = pick(rnd, V_STREETS);
      const lane = chance(rnd, 0.5) ? -s.w / 4 : s.w / 4;
      tx = s.x + lane; tz = range(rnd, 100, 3350); tyaw = lane < 0 ? 0 : Math.PI;
    } else {
      const s = pick(rnd, H_STREETS);
      const lane = chance(rnd, 0.5) ? -s.w / 4 : s.w / 4;
      tx = range(rnd, 100, 3740); tz = s.z + lane; tyaw = lane < 0 ? Math.PI / 2 : -Math.PI / 2;
    }
    if (Math.hypot(tx - PLAZA.x, tz - PLAZA.z) < 145) continue; // keep the plaza clear
    if (tz > CANAL.z0 - 10 && tz < CANAL.z1 + 10 && tx < 3120) continue; // not in the canal
    addCar(tx, tz, tyaw, 'traffic', chance(rnd, 0.25) ? '#f2c200' : pick(rnd, CAR_COLORS));
  }

  // ---------- pedestrians (on sidewalks) ----------
  const JACKETS = ['#e23b3b', '#f2c200', '#2fa8a0', '#e07b2a', '#d63384', '#3b7de2', '#7ac74f'];
  for (let i = 0; i < 40; i++) {
    const sw = pick(rnd, city.sidewalks);
    const along = range(rnd, -0.45, 0.45);
    const lat = range(rnd, -sw.w / 4, sw.w / 4);
    // along-axis is local +Z (sin yaw, cos yaw); lateral is local +X (cos yaw, -sin yaw)
    const px = sw.x + Math.sin(sw.yaw) * along * sw.d + Math.cos(sw.yaw) * lat;
    const pz = sw.z + Math.cos(sw.yaw) * along * sw.d - Math.sin(sw.yaw) * lat;
    city.pedestrians.push({ x: px, z: pz, yaw: range(rnd, 0, Math.PI * 2), jacket: pick(rnd, JACKETS) });
  }

  // ---------- boats ----------
  for (let i = 0; i < 5; i++) {
    city.boats.push({ x: range(rnd, 3250, 3750), z: range(rnd, 2500, 3050), yaw: range(rnd, 0, Math.PI * 2) });
  }
  city.boats.push({ x: 620, z: 2838, yaw: Math.PI / 2 }, { x: 2450, z: 2838, yaw: -Math.PI / 2 });

  // ---------- neon landmark signs ----------
  const SIGN_SLOTS = ['PALKON', 'PEARL', 'GLASS', 'MARKET'];
  const signSpots = [
    { x: 1920, z: 1728 - 96, yaw: 0, y: 46, w: 26, h: 5, slot: 0 }, // clock tower base
    { x: 3400, z: 2700, yaw: Math.PI / 2, y: 14, w: 18, h: 4, slot: 1 }, // marina
    { x: 3300, z: 900, yaw: -Math.PI / 2, y: 30, w: 18, h: 4, slot: 2 }, // glasspoint
    { x: 2100, z: 1500, yaw: 0, y: 12, w: 18, h: 4, slot: 3 }, // market hall
  ];
  for (const s of signSpots) city.signs.push(s);
  void SIGN_SLOTS;

  // ---------- helpers for the verifier / renderer ----------
  city.counts = {
    buildings: city.buildings.length,
    trees: city.trees.length,
    lamps: city.lamps.length,
    trafficLights: city.trafficLights.length,
    cars: city.cars.length,
    parked: city.cars.filter((c) => c.kind === 'parked').length,
    drivable: city.cars.filter((c) => c.kind === 'drivable').length,
    traffic: city.cars.filter((c) => c.kind === 'traffic').length,
    pedestrians: city.pedestrians.length,
    boats: city.boats.length,
    sidewalks: city.sidewalks.length,
    cornerPads: city.cornerPads.length,
    bridges: city.bridges.length,
  };
  city.districtCounts = {};
  for (const b of city.buildings) {
    city.districtCounts[b.district] = (city.districtCounts[b.district] || 0) + 1;
  }
  return city;
}

// Rotated-rectangle corners (for overlap checks). yaw rotates local +Z to world.
export function rectCorners(x, z, w, d, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const pts = [];
  for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) {
    pts.push([x + lx * c + lz * s, z - lx * s + lz * c]);
  }
  return pts;
}

// Point-in-rotated-rect test. Forward transform is
// wx = x + lx*cos(yaw) + lz*sin(yaw); wz = z - lx*sin(yaw) + lz*cos(yaw),
// so the inverse is lx = dx*cos(yaw) - dz*sin(yaw); lz = dx*sin(yaw) + dz*cos(yaw).
export function pointInRect(px, pz, x, z, w, d, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const dx = px - x, dz = pz - z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= w / 2 && Math.abs(lz) <= d / 2;
}
