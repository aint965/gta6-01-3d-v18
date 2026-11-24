// Mesh building: one merged static buffer for the city, a dynamic buffer for
// cars, and a per-preset sky buffer. Vertices are interleaved:
// [px,py,pz, nx,ny,nz, r,g,b, er,eg,eb, spc, u, v, tex] = 16 floats.
// spc < 0 marks an UNLIT vertex (sky dome, sun, moon, stars): the shader
// skips lighting and fog for those.
import { mulberry32, range, pick, chance } from './rng.js';
import { rectCorners } from './city.js';

export const STRIDE = 16;

function v3sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function v3cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function v3norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
// Rotate a vector around Y by yaw. Local +Z maps to (sin yaw, cos yaw).
export function rotY(v, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

export class Builder {
  constructor() {
    this.data = [];
  }
  get vertCount() { return this.data.length / STRIDE; }
  // One vertex.
  vert(p, n, col, emi, spc, uv, tex) {
    this.data.push(
      p[0], p[1], p[2], n[0], n[1], n[2],
      col[0], col[1], col[2], emi[0], emi[1], emi[2],
      spc, uv[0], uv[1], tex,
    );
  }
  // Triangle from 3 corners; normal from winding.
  tri(a, b, c, opt = {}) {
    const n = v3norm(v3cross(v3sub(b, a), v3sub(c, a)));
    const col = opt.c || [1, 1, 1];
    const emi = opt.e || [0, 0, 0];
    const spc = opt.s ?? 0;
    const uvs = opt.uv || [[0, 0], [1, 0], [1, 1]];
    const t = opt.t ?? 0;
    this.vert(a, n, col, emi, spc, uvs[0], t);
    this.vert(b, n, col, emi, spc, uvs[1], t);
    this.vert(c, n, col, emi, spc, uvs[2], t);
  }
  // Quad a,b,c,d (CCW from outside) -> two triangles.
  quad(a, b, c, d, opt = {}) {
    const uvs = opt.uv || [[0, 0], [1, 0], [1, 1], [0, 1]];
    this.tri(a, b, c, { ...opt, uv: [uvs[0], uvs[1], uvs[2]] });
    this.tri(a, c, d, { ...opt, uv: [uvs[0], uvs[2], uvs[3]] });
  }
  // Axis-aligned-or-yawed box centred at (cx,cy,cz), size (w,h,d).
  // face: {top,bottom,front,back,left,right} each {c,e,s}; skip: face names to omit.
  box(cx, cy, cz, w, h, d, yaw, face, skip = []) {
    const hw = w / 2, hh = h / 2, hd = d / 2;
    // local corners, face order chosen so the computed normal points outward
    const F = {
      front: [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]],
      back: [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]],
      right: [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]],
      left: [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]],
      top: [[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd]],
      bottom: [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd]],
    };
    for (const name of ['front', 'back', 'right', 'left', 'top', 'bottom']) {
      if (skip.includes(name)) continue;
      const f = face[name] || { c: [1, 1, 1], e: [0, 0, 0], s: 0 };
      const corners = F[name].map(([lx, ly, lz]) => {
        const [rx, , rz] = rotY([lx, 0, lz], yaw);
        return [cx + rx, cy + ly, cz + rz];
      });
      this.quad(corners[0], corners[1], corners[2], corners[3], { c: f.c, e: f.e, s: f.s ?? 0 });
    }
  }
  // Pyramid (4 triangles + base quad) centred at (cx,cy,cz), base w x d, height h.
  // Triangle winding (base[i+1], base[i], apex) gives outward-up normals.
  pyramid(cx, cy, cz, w, h, d, yaw, col, emi = [0, 0, 0], spc = 0) {
    const hw = w / 2, hd = d / 2;
    const base = [[-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd]].map(([lx, , lz]) => {
      const [rx, , rz] = rotY([lx, 0, lz], yaw);
      return [cx + rx, cy, cz + rz];
    });
    const apex = [cx, cy + h, cz];
    const opt = { c: col, e: emi, s: spc };
    this.tri(base[1], base[0], apex, opt);
    this.tri(base[2], base[1], apex, opt);
    this.tri(base[3], base[2], apex, opt);
    this.tri(base[0], base[3], apex, opt);
  }
  // Flat disc (fan) facing up, centred at (cx,cy,cz), radius r.
  disc(cx, cy, cz, r, segments, col, emi = [0, 0, 0], spc = 0) {
    const opt = { c: col, e: emi, s: spc };
    const centre = [cx, cy, cz];
    let prev = [cx + r, cy, cz];
    for (let i = 1; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const p = [cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r];
      this.tri(centre, p, prev, opt);
      prev = p;
    }
  }
  // Ring wall (vertical band) — used for the fountain basin. Winding gives
  // outward normals.
  ring(cx, cy, cz, r, h, segments, col, emi = [0, 0, 0], spc = 0) {
    const opt = { c: col, e: emi, s: spc };
    let prevA = 0;
    for (let i = 1; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const p0 = [cx + Math.cos(prevA) * r, cy, cz + Math.sin(prevA) * r];
      const p1 = [cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r];
      const p2 = [cx + Math.cos(a) * r, cy + h, cz + Math.sin(a) * r];
      const p3 = [cx + Math.cos(prevA) * r, cy + h, cz + Math.sin(prevA) * r];
      this.quad(p1, p0, p3, p2, opt);
      prevA = a;
    }
  }
  build() {
    return {
      data: new Float32Array(this.data),
      count: this.vertCount,
    };
  }
}

// Face frame of a building face, in world coords.
// Returns {o (face centre at y=0), u (axis along face), v (up), n (outward normal)}.
export function faceFrame(b, face) {
  const hw = b.w / 2, hd = b.d / 2;
  let o, u, n;
  if (face === 'front') { o = [0, 0, hd]; u = [1, 0, 0]; n = [0, 0, 1]; }
  else if (face === 'back') { o = [0, 0, -hd]; u = [-1, 0, 0]; n = [0, 0, -1]; }
  else if (face === 'right') { o = [hw, 0, 0]; u = [0, 0, -1]; n = [1, 0, 0]; }
  else { o = [-hw, 0, 0]; u = [0, 0, 1]; n = [-1, 0, 0]; }
  const ro = rotY(o, b.yaw);
  const ru = rotY(u, b.yaw);
  const rn = rotY(n, b.yaw);
  return { o: [b.x + ro[0], 0, b.z + ro[2]], u: ru, v: [0, 1, 0], n: rn };
}

// Quad on a building face: u0..u1 along the face, v0..v1 height, offset out from the wall.
export function faceQuad(B, b, face, u0, u1, v0, v1, off, opt, uv) {
  const fr = faceFrame(b, face);
  const pt = (uu, vv, oo) => [
    fr.o[0] + fr.u[0] * uu + fr.v[0] * vv + fr.n[0] * oo,
    fr.o[1] + fr.u[1] * uu + fr.v[1] * vv + fr.n[1] * oo,
    fr.o[2] + fr.u[2] * uu + fr.v[2] * vv + fr.n[2] * oo,
  ];
  // A uv array implies the atlas texture path (t=1); without uv the quad is untextured.
  B.quad(pt(u0, v0, off), pt(u1, v0, off), pt(u1, v1, off), pt(u0, v1, off), { ...opt, uv, t: opt.t ?? (uv ? 1 : 0) });
}

function shade(col, f) {
  return [Math.min(1, col[0] * f), Math.min(1, col[1] * f), Math.min(1, col[2] * f)];
}

const DARK_GLASS = [0.14, 0.18, 0.24];
const LIT_WARM = [1.0, 0.82, 0.45];
const LIT_EMI = [1.0, 0.72, 0.35];
const CURTAIN = [0.54, 0.48, 0.4];

export function buildStaticMesh(city) {
  const B = new Builder();
  const rnd = mulberry32(city.seed + 7);

  // ---------- ground (winding (x0,z0),(x0,z1),(x1,z1),(x1,z0) = up normal) ----------
  const GRASS = [0.32, 0.45, 0.26];
  const SAND = [0.82, 0.72, 0.5];
  const STONE = [0.66, 0.6, 0.5];
  const PARK_GREEN = [0.28, 0.42, 0.24];
  // base ground
  B.quad([0, 0, 0], [0, 0, 3456], [3840, 0, 3456], [3840, 0, 0], { c: GRASS });
  // beach sand strip (south edge)
  B.quad([0, 0.05, 3240], [0, 0.05, 3456], [3840, 0.05, 3456], [3840, 0.05, 3240], { c: SAND });
  // park grass
  B.quad([2400, 0.05, 864], [2400, 0.05, 1296], [2880, 0.05, 1296], [2880, 0.05, 864], { c: PARK_GREEN });
  // plaza stone disc
  B.disc(1920, 0.08, 1728, 130, 24, STONE);
  // canal + harbour water
  const WATER = [0.16, 0.38, 0.52];
  B.quad([0, 0.1, 2760], [0, 0.1, 2916], [3840, 0.1, 2916], [3840, 0.1, 2760], { c: WATER, s: 1.0 });
  B.quad([3120, 0.1, 2376], [3120, 0.1, 3240], [3840, 0.1, 3240], [3840, 0.1, 2376], { c: WATER, s: 1.0 });

  // ---------- roads ----------
  const ASPHALT = [0.19, 0.19, 0.21];
  const LINE = [0.75, 0.72, 0.6];
  for (const r of city.roads) {
    const dx = r.x2 - r.x1, dz = r.z2 - r.z1;
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    // road quad: local +Z along the road, width across
    const ux = Math.cos(yaw), uz = -Math.sin(yaw); // local +X in world
    const fx = Math.sin(yaw), fz = Math.cos(yaw); // local +Z in world
    const cx = (r.x1 + r.x2) / 2, cz = (r.z1 + r.z2) / 2;
    const hw = r.w / 2, hl = len / 2;
    const corner = (sx, sz) => [
      cx + ux * sx * hw + fx * sz * hl,
      r.y,
      cz + uz * sx * hw + fz * sz * hl,
    ];
    B.quad(corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1), { c: ASPHALT });
    // centre dashes on the big streets
    if ((r.kind === 'boulevard' || r.kind === 'cross' || r.kind === 'secondary') && len > 100) {
      const n = Math.floor(len / 36);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const px = cx + fx * (t - 0.5) * len;
        const pz = cz + fz * (t - 0.5) * len;
        const ddx = ux * 0.35, ddz = uz * 0.35;
        const ffx = fx * 7, ffz = fz * 7;
        B.quad(
          [px - ddx - ffx, r.y + 0.05, pz - ddz - ffz],
          [px - ddx + ffx, r.y + 0.05, pz - ddz + ffz],
          [px + ddx + ffx, r.y + 0.05, pz + ddz + ffz],
          [px + ddx - ffx, r.y + 0.05, pz + ddz - ffz],
          { c: LINE },
        );
      }
    }
  }
  // bridge decks (raised, with side rails)
  for (const br of city.bridges) {
    const len = br.z1 - br.z0;
    B.box(br.x, 0.35, (br.z0 + br.z1) / 2, br.w, 0.7, len, 0, {
      top: { c: [0.42, 0.4, 0.38] }, bottom: { c: [0.2, 0.2, 0.2] },
      front: { c: [0.36, 0.34, 0.32] }, back: { c: [0.36, 0.34, 0.32] },
      left: { c: [0.36, 0.34, 0.32] }, right: { c: [0.36, 0.34, 0.32] },
    }, ['bottom']);
    for (const side of [-1, 1]) {
      B.box(br.x + side * (br.w / 2 - 0.4), 1.15, (br.z0 + br.z1) / 2, 0.8, 0.9, len, 0, {
        top: { c: [0.5, 0.48, 0.44] }, bottom: { c: [0.2, 0.2, 0.2] },
        front: { c: [0.45, 0.43, 0.4] }, back: { c: [0.45, 0.43, 0.4] },
        left: { c: [0.45, 0.43, 0.4] }, right: { c: [0.45, 0.43, 0.4] },
      }, ['bottom']);
    }
  }

  // ---------- sidewalks (raised strips, light pavement top, dark curb sides) ----------
  const PAVE = [0.78, 0.71, 0.58];
  const CURB = [0.5, 0.45, 0.36];
  for (const sw of city.sidewalks) {
    B.box(sw.x, 0.09, sw.z, sw.w, 0.18, sw.d, sw.yaw, {
      top: { c: PAVE }, bottom: { c: CURB },
      front: { c: CURB }, back: { c: CURB },
      left: { c: CURB }, right: { c: CURB },
    }, ['bottom']);
  }
  for (const pad of city.cornerPads) {
    B.box(pad.x, 0.09, pad.z, pad.s, 0.18, pad.s, 0, {
      top: { c: PAVE }, bottom: { c: CURB },
      front: { c: CURB }, back: { c: CURB },
      left: { c: CURB }, right: { c: CURB },
    }, ['bottom']);
  }

  // ---------- buildings ----------
  for (const b of city.buildings) {
    const wall = b.wall;
    const faceCol = (f) => shade(wall, f);
    B.box(b.x, b.h / 2, b.z, b.w, b.h, b.d, b.yaw, {
      top: { c: b.roof }, bottom: { c: [0.1, 0.1, 0.1] },
      front: { c: faceCol(1.0) }, back: { c: faceCol(0.84) },
      left: { c: faceCol(0.88) }, right: { c: faceCol(0.93) },
    }, ['bottom']);
    // ground-floor band (slightly proud, darker tone)
    B.box(b.x, 1.7, b.z, b.w + 0.25, 3.4, b.d + 0.25, b.yaw, {
      top: { c: shade(wall, 0.7) }, bottom: { c: [0.1, 0.1, 0.1] },
      front: { c: shade(wall, 0.72) }, back: { c: shade(wall, 0.66) },
      left: { c: shade(wall, 0.68) }, right: { c: shade(wall, 0.7) },
    }, ['top', 'bottom']);
    // cornice / parapet line at the roof edge
    B.box(b.x, b.h - 0.25, b.z, b.w + 0.6, 0.5, b.d + 0.6, b.yaw, {
      top: { c: shade(wall, 1.25) }, bottom: { c: shade(wall, 0.8) },
      front: { c: shade(wall, 1.15) }, back: { c: shade(wall, 1.05) },
      left: { c: shade(wall, 1.1) }, right: { c: shade(wall, 1.12) },
    }, ['top', 'bottom']);
    // roofline variation: setback box or rim
    if (b.h >= 15 && chance(rnd, 0.5)) {
      B.box(b.x, b.h + 1.1, b.z, b.w * 0.55, 2.2, b.d * 0.55, b.yaw, {
        top: { c: b.roof }, bottom: { c: [0.1, 0.1, 0.1] },
        front: { c: shade(wall, 0.9) }, back: { c: shade(wall, 0.82) },
        left: { c: shade(wall, 0.85) }, right: { c: shade(wall, 0.88) },
      }, ['bottom']);
    } else {
      B.box(b.x, b.h + 0.3, b.z, b.w + 0.35, 0.6, b.d + 0.35, b.yaw, {
        top: { c: shade(wall, 1.1) }, bottom: { c: shade(wall, 0.8) },
        front: { c: shade(wall, 1.0) }, back: { c: shade(wall, 0.95) },
        left: { c: shade(wall, 0.98) }, right: { c: shade(wall, 1.0) },
      }, ['top', 'bottom']);
    }
    // rooftop props on ~45% of buildings 15 m or taller
    if (b.h >= 15 && chance(rnd, 0.45)) {
      const px = b.x + range(rnd, -b.w / 4, b.w / 4);
      const pz = b.z + range(rnd, -b.d / 4, b.d / 4);
      const kind = pick(rnd, ['ac', 'tank', 'antenna']);
      if (kind === 'ac') {
        B.box(px, b.h + 0.5, pz, 1.8, 1.0, 1.3, b.yaw, {
          top: { c: [0.6, 0.62, 0.62] }, bottom: { c: [0.2, 0.2, 0.2] },
          front: { c: [0.5, 0.52, 0.52] }, back: { c: [0.45, 0.47, 0.47] },
          left: { c: [0.48, 0.5, 0.5] }, right: { c: [0.5, 0.52, 0.52] },
        }, ['bottom']);
      } else if (kind === 'tank') {
        B.box(px, b.h + 1.1, pz, 1.9, 2.2, 1.9, b.yaw, {
          top: { c: [0.55, 0.42, 0.3] }, bottom: { c: [0.2, 0.2, 0.2] },
          front: { c: [0.5, 0.38, 0.26] }, back: { c: [0.45, 0.34, 0.23] },
          left: { c: [0.48, 0.36, 0.25] }, right: { c: [0.5, 0.38, 0.26] },
        }, ['bottom']);
        B.pyramid(px, b.h + 2.2, pz, 2.1, 0.9, 2.1, b.yaw, [0.55, 0.42, 0.3]);
      } else {
        B.box(px, b.h + 3, pz, 0.18, 6, 0.18, b.yaw, {
          top: { c: [0.4, 0.4, 0.4] }, bottom: { c: [0.2, 0.2, 0.2] },
          front: { c: [0.35, 0.35, 0.35] }, back: { c: [0.35, 0.35, 0.35] },
          left: { c: [0.35, 0.35, 0.35] }, right: { c: [0.35, 0.35, 0.35] },
        }, ['bottom']);
        B.box(px, b.h + 4.4, pz, 1.6, 0.14, 0.14, b.yaw, {
          top: { c: [0.4, 0.4, 0.4] }, bottom: { c: [0.2, 0.2, 0.2] },
          front: { c: [0.35, 0.35, 0.35] }, back: { c: [0.35, 0.35, 0.35] },
          left: { c: [0.35, 0.35, 0.35] }, right: { c: [0.35, 0.35, 0.35] },
        }, ['bottom']);
      }
    }
    // shopfront on the boulevard: glass band + awning + sign
    if (b.shop) {
      const face = b.frontFace;
      const fw = face === 'front' || face === 'back' ? b.w : b.d;
      faceQuad(B, b, face, -fw / 2 + 0.5, fw / 2 - 0.5, 0.4, 3.0, 0.07,
        { c: [0.1, 0.13, 0.18], e: [0, 0, 0], s: 0.9 });
      // awning (angled, coral or teal)
      const awnCol = pick(rnd, [[0.85, 0.5, 0.4], [0.22, 0.56, 0.6], [0.85, 0.62, 0.3]]);
      const fr = faceFrame(b, face);
      const apt = (uu, vv, oo) => [
        fr.o[0] + fr.u[0] * uu + fr.v[0] * vv + fr.n[0] * oo,
        fr.o[1] + fr.u[1] * uu + fr.v[1] * vv + fr.n[1] * oo,
        fr.o[2] + fr.u[2] * uu + fr.v[2] * vv + fr.n[2] * oo,
      ];
      B.quad(
        apt(-fw / 2 + 0.4, 2.6, 1.35), apt(fw / 2 - 0.4, 2.6, 1.35),
        apt(fw / 2 - 0.4, 3.45, 0.08), apt(-fw / 2 + 0.4, 3.45, 0.08),
        { c: awnCol, s: 0.1 },
      );
      // sign board with atlas texture
      if (b.sign !== null && b.sign !== undefined) {
        const u0 = b.sign / 8, u1 = (b.sign + 1) / 8;
        faceQuad(B, b, face, -fw / 2 + 1.2, fw / 2 - 1.2, 3.8, 4.9, 0.09,
          { c: [0.12, 0.12, 0.14], e: [0, 0, 0], s: 0 },
          [[u0, 0], [u1, 0], [u1, 1], [u0, 1]]);
        // light pool on the pavement in front of the shop
        const faceDist = (face === 'front' || face === 'back') ? b.d / 2 : b.w / 2;
        const poolC = [fr.o[0] + fr.n[0] * (faceDist + 2.2), 0.21, fr.o[2] + fr.n[2] * (faceDist + 2.2)];
        const poolU = fr.u;
        const pw = Math.min(fw, 8) / 2, pd = 1.6;
        B.quad(
          [poolC[0] - poolU[0] * pw - fr.n[0] * pd, 0.21, poolC[2] - poolU[2] * pw - fr.n[2] * pd],
          [poolC[0] - poolU[0] * pw + fr.n[0] * pd, 0.21, poolC[2] - poolU[2] * pw + fr.n[2] * pd],
          [poolC[0] + poolU[0] * pw + fr.n[0] * pd, 0.21, poolC[2] + poolU[2] * pw + fr.n[2] * pd],
          [poolC[0] + poolU[0] * pw - fr.n[0] * pd, 0.21, poolC[2] + poolU[2] * pw - fr.n[2] * pd],
          { c: [0.1, 0.1, 0.1], e: [0.55, 0.42, 0.2], s: 0 },
        );
      }
    }
    // windows: front face + opposite face (+ a side face on wide buildings)
    const faces = [b.frontFace, b.frontFace === 'front' ? 'back' : b.frontFace === 'back' ? 'front' : b.frontFace === 'left' ? 'right' : 'left'];
    if (Math.max(b.w, b.d) > 26) {
      const side = b.w > b.d ? 'left' : 'front';
      if (!faces.includes(side)) faces.push(side);
    }
    for (const face of faces) {
      const fw = face === 'front' || face === 'back' ? b.w : b.d;
      const cols = Math.max(1, Math.floor((fw - 2) / 3.2));
      const rows = Math.max(1, Math.floor((b.h - 5.5) / 3.1));
      const ww = 1.5, wh = 1.9;
      for (let ci = 0; ci < cols; ci++) {
        for (let ri = 0; ri < rows; ri++) {
          const u0 = -fw / 2 + 1.2 + ci * ((fw - 2.4) / cols) + range(rnd, -0.12, 0.12);
          const v0 = 4.6 + ri * 3.1 + range(rnd, -0.1, 0.1);
          if (v0 + wh > b.h - 1.2) continue;
          const r = rnd();
          if (b.glass) {
            faceQuad(B, b, face, u0, u0 + ww, v0, v0 + wh, 0.06,
              { c: [0.55, 0.72, 0.8], e: [0.05, 0.1, 0.14], s: 0.95 });
          } else if (r < 0.55) {
            faceQuad(B, b, face, u0, u0 + ww, v0, v0 + wh, 0.06,
              { c: DARK_GLASS, e: [0, 0, 0], s: 0.7 });
          } else if (r < 0.82) {
            faceQuad(B, b, face, u0, u0 + ww, v0, v0 + wh, 0.06,
              { c: LIT_WARM, e: LIT_EMI, s: 0 });
          } else {
            faceQuad(B, b, face, u0, u0 + ww, v0, v0 + wh, 0.06,
              { c: CURTAIN, e: [0, 0, 0], s: 0.1 });
          }
          // balcony slab on ~10% of windows
          if (chance(rnd, 0.1) && v0 > 6) {
            const fr = faceFrame(b, face);
            const bpt = (uu, vv, oo) => [
              fr.o[0] + fr.u[0] * uu + fr.v[0] * vv + fr.n[0] * oo,
              fr.o[1] + fr.u[1] * uu + fr.v[1] * vv + fr.n[1] * oo,
              fr.o[2] + fr.u[2] * uu + fr.v[2] * vv + fr.n[2] * oo,
            ];
            const su0 = u0 - 0.2, su1 = u0 + ww + 0.2;
            B.quad(bpt(su0, v0 - 0.12, 0.65), bpt(su1, v0 - 0.12, 0.65), bpt(su1, v0 - 0.12, 0.07), bpt(su0, v0 - 0.12, 0.07), { c: shade(wall, 0.85) });
            B.quad(bpt(su0, v0 - 0.12, 0.65), bpt(su0, v0 - 0.7, 0.65), bpt(su1, v0 - 0.7, 0.65), bpt(su1, v0 - 0.12, 0.65), { c: shade(wall, 0.75) });
          }
        }
      }
    }
  }

  // ---------- clock tower + fountain (plaza) ----------
  const TOWER = [0.88, 0.82, 0.66];
  B.box(1920, 35, 1728, 14, 70, 14, 0, {
    top: { c: [0.5, 0.45, 0.38] }, bottom: { c: [0.1, 0.1, 0.1] },
    front: { c: TOWER }, back: { c: shade(TOWER, 0.85) },
    left: { c: shade(TOWER, 0.88) }, right: { c: shade(TOWER, 0.92) },
  }, ['bottom']);
  B.pyramid(1920, 70, 1728, 16, 9, 16, 0, [0.35, 0.42, 0.45]);
  // clock faces (white discs with dark hands) on all four sides
  for (const [dx, dz, ry] of [[0, 7.1, 0], [0, -7.1, Math.PI], [7.1, 0, Math.PI / 2], [-7.1, 0, -Math.PI / 2]]) {
    const c = Math.cos(ry), s = Math.sin(ry);
    const nx = s, nz = c; // outward normal for this face
    const ux = c, uz = -s; // axis along the face
    const ccx = 1920 + dx, ccz = 1728 + dz, cy = 58;
    const quad = (du0, dv0, du1, dv1, col, emi) => {
      B.quad(
        [ccx + ux * du0 + nx * 0.08, cy + dv0, ccz + uz * du0 + nz * 0.08],
        [ccx + ux * du1 + nx * 0.08, cy + dv0, ccz + uz * du1 + nz * 0.08],
        [ccx + ux * du1 + nx * 0.08, cy + dv1, ccz + uz * du1 + nz * 0.08],
        [ccx + ux * du0 + nx * 0.08, cy + dv1, ccz + uz * du0 + nz * 0.08],
        { c: col, e: emi || [0, 0, 0] },
      );
    };
    quad(-3.6, -3.6, 3.6, 3.6, [0.94, 0.93, 0.88], [0.25, 0.25, 0.22]);
    quad(-0.18, 0, 0.18, 3.0, [0.12, 0.12, 0.14]); // minute hand
    quad(-0.18, -2.0, 0.18, 0.2, [0.12, 0.12, 0.14]); // hour hand
  }
  // fountain: basin ring + water disc + centre column
  B.ring(1920, 0, 1788, 9, 1.1, 16, [0.72, 0.68, 0.58]);
  B.disc(1920, 0.55, 1788, 8.6, 16, [0.2, 0.45, 0.6], [0, 0, 0], 1.0);
  B.box(1920, 2.2, 1788, 1.6, 3.4, 1.6, 0, {
    top: { c: [0.7, 0.66, 0.56] }, bottom: { c: [0.2, 0.2, 0.2] },
    front: { c: [0.66, 0.62, 0.52] }, back: { c: [0.6, 0.56, 0.48] },
    left: { c: [0.63, 0.59, 0.5] }, right: { c: [0.65, 0.61, 0.51] },
  }, ['bottom']);
  B.disc(1920, 4.0, 1788, 2.6, 12, [0.25, 0.5, 0.65], [0, 0, 0], 1.0);

  // ---------- trees ----------
  for (const t of city.trees) {
    const leaf = t.kind === 'palm' ? [0.35, 0.55, 0.3] : [0.3, 0.5, 0.25];
    B.box(t.x, 0.9, t.z, 0.45 * t.s, 1.8 * t.s, 0.45 * t.s, 0, {
      top: { c: [0.4, 0.3, 0.2] }, bottom: { c: [0.2, 0.15, 0.1] },
      front: { c: [0.38, 0.28, 0.18] }, back: { c: [0.32, 0.24, 0.16] },
      left: { c: [0.35, 0.26, 0.17] }, right: { c: [0.37, 0.27, 0.18] },
    }, ['bottom']);
    B.pyramid(t.x, 1.7 * t.s, t.z, 2.6 * t.s, 3.0 * t.s, 2.6 * t.s, 0.6, leaf);
    B.pyramid(t.x, 3.4 * t.s, t.z, 1.8 * t.s, 2.0 * t.s, 1.8 * t.s, 1.1, shade(leaf, 1.15));
  }

  // ---------- lamps ----------
  const LAMP_EMI = [1.0, 0.78, 0.42];
  for (const l of city.lamps) {
    B.box(l.x, 2.6, l.z, 0.2, 5.2, 0.2, 0, {
      top: { c: [0.15, 0.15, 0.16] }, bottom: { c: [0.1, 0.1, 0.1] },
      front: { c: [0.14, 0.14, 0.15] }, back: { c: [0.13, 0.13, 0.14] },
      left: { c: [0.14, 0.14, 0.15] }, right: { c: [0.14, 0.14, 0.15] },
    }, ['bottom']);
    B.box(l.x, 5.3, l.z, 0.7, 0.28, 0.4, 0, {
      top: { c: [0.2, 0.2, 0.2], e: LAMP_EMI }, bottom: { c: [0.1, 0.1, 0.1] },
      front: { c: [0.18, 0.18, 0.18], e: LAMP_EMI }, back: { c: [0.18, 0.18, 0.18], e: LAMP_EMI },
      left: { c: [0.18, 0.18, 0.18], e: LAMP_EMI }, right: { c: [0.18, 0.18, 0.18], e: LAMP_EMI },
    }, ['bottom']);
    // light pool on the pavement (emissive, night only via uEmisBoost)
    B.quad(
      [l.x - 1.6, 0.22, l.z - 1.6], [l.x - 1.6, 0.22, l.z + 1.6],
      [l.x + 1.6, 0.22, l.z + 1.6], [l.x + 1.6, 0.22, l.z - 1.6],
      { c: [0.1, 0.1, 0.1], e: [0.5, 0.36, 0.16] },
    );
  }

  // ---------- traffic lights ----------
  for (const tl of city.trafficLights) {
    B.box(tl.x, 3.4, tl.z, 0.28, 6.8, 0.28, 0, {
      top: { c: [0.12, 0.12, 0.12] }, bottom: { c: [0.1, 0.1, 0.1] },
      front: { c: [0.11, 0.11, 0.11] }, back: { c: [0.11, 0.11, 0.11] },
      left: { c: [0.11, 0.11, 0.11] }, right: { c: [0.11, 0.11, 0.11] },
    }, ['bottom']);
    B.box(tl.x, 7.4, tl.z, 0.7, 1.9, 0.55, tl.face, {
      top: { c: [0.1, 0.1, 0.1] }, bottom: { c: [0.1, 0.1, 0.1] },
      front: { c: [0.09, 0.09, 0.09] }, back: { c: [0.09, 0.09, 0.09] },
      left: { c: [0.09, 0.09, 0.09] }, right: { c: [0.09, 0.09, 0.09] },
    }, ['bottom']);
    // three lamp quads on the head's front face
    const fr = { o: [tl.x, 0, tl.z], u: rotY([1, 0, 0], tl.face), n: rotY([0, 0, 1], tl.face) };
    const lampQuad = (vy, on, col) => {
      const off = 0.3;
      const c0 = [fr.o[0] + fr.n[0] * off - fr.u[0] * 0.22, 7.4 + vy - 0.22, fr.o[2] + fr.n[2] * off - fr.u[2] * 0.22];
      const c1 = [fr.o[0] + fr.n[0] * off + fr.u[0] * 0.22, 7.4 + vy - 0.22, fr.o[2] + fr.n[2] * off + fr.u[2] * 0.22];
      const c2 = [fr.o[0] + fr.n[0] * off + fr.u[0] * 0.22, 7.4 + vy + 0.22, fr.o[2] + fr.n[2] * off + fr.u[2] * 0.22];
      const c3 = [fr.o[0] + fr.n[0] * off - fr.u[0] * 0.22, 7.4 + vy + 0.22, fr.o[2] + fr.n[2] * off - fr.u[2] * 0.22];
      B.quad(c0, c1, c2, c3, { c: on ? col : [0.16, 0.16, 0.16], e: on ? col : [0, 0, 0] });
    };
    lampQuad(0.62, tl.state === 'red', [1.0, 0.12, 0.08]);
    lampQuad(0, tl.state === 'yellow', [1.0, 0.75, 0.1]);
    lampQuad(-0.62, tl.state === 'green', [0.15, 0.85, 0.3]);
  }

  // ---------- boats ----------
  for (const bo of city.boats) {
    B.box(bo.x, 0.7, bo.z, 7, 1.4, 2.6, bo.yaw, {
      top: { c: [0.85, 0.85, 0.85] }, bottom: { c: [0.2, 0.25, 0.3] },
      front: { c: [0.75, 0.78, 0.82] }, back: { c: [0.7, 0.73, 0.77] },
      left: { c: [0.72, 0.75, 0.79] }, right: { c: [0.74, 0.77, 0.81] },
    }, ['bottom']);
    B.box(bo.x, 1.9, bo.z, 3.2, 1.2, 2.0, bo.yaw, {
      top: { c: [0.9, 0.9, 0.88] }, bottom: { c: [0.2, 0.2, 0.2] },
      front: { c: [0.8, 0.82, 0.85] }, back: { c: [0.75, 0.77, 0.8] },
      left: { c: [0.78, 0.8, 0.83] }, right: { c: [0.79, 0.81, 0.84] },
    }, ['bottom']);
    B.box(bo.x, 4.4, bo.z, 0.16, 5.4, 0.16, bo.yaw, {
      top: { c: [0.4, 0.35, 0.28] }, bottom: { c: [0.2, 0.2, 0.2] },
      front: { c: [0.38, 0.33, 0.26] }, back: { c: [0.38, 0.33, 0.26] },
      left: { c: [0.38, 0.33, 0.26] }, right: { c: [0.38, 0.33, 0.26] },
    }, ['bottom']);
  }

  // ---------- pedestrians ----------
  for (const p of city.pedestrians) {
    const jacket = [parseInt(p.jacket.slice(1, 3), 16) / 255, parseInt(p.jacket.slice(3, 5), 16) / 255, parseInt(p.jacket.slice(5, 7), 16) / 255];
    B.box(p.x, 1.05, p.z, 0.55, 1.1, 0.36, p.yaw, {
      top: { c: jacket }, bottom: { c: [0.15, 0.15, 0.15] },
      front: { c: jacket }, back: { c: shade(jacket, 0.85) },
      left: { c: shade(jacket, 0.9) }, right: { c: shade(jacket, 0.92) },
    }, ['bottom']);
    B.box(p.x, 1.85, p.z, 0.34, 0.36, 0.34, p.yaw, {
      top: { c: [0.85, 0.68, 0.52] }, bottom: { c: [0.4, 0.3, 0.22] },
      front: { c: [0.82, 0.65, 0.5] }, back: { c: [0.78, 0.62, 0.48] },
      left: { c: [0.8, 0.64, 0.49] }, right: { c: [0.81, 0.64, 0.49] },
    }, ['bottom']);
    B.box(p.x, 0.35, p.z, 0.5, 0.7, 0.32, p.yaw, {
      top: { c: [0.2, 0.2, 0.22] }, bottom: { c: [0.1, 0.1, 0.1] },
      front: { c: [0.18, 0.18, 0.2] }, back: { c: [0.18, 0.18, 0.2] },
      left: { c: [0.18, 0.18, 0.2] }, right: { c: [0.18, 0.18, 0.2] },
    }, ['bottom']);
  }

  // ---------- neon landmark signs (atlas texture, t=1) ----------
  for (const s of city.signs) {
    const u0 = s.slot / 8, u1 = (s.slot + 1) / 8;
    const n = rotY([0, 0, 1], s.yaw);
    const u = rotY([1, 0, 0], s.yaw);
    const hw = s.w / 2, hh = s.h / 2;
    const c0 = [s.x - u[0] * hw + n[0] * 0.1, s.y - hh, s.z - u[2] * hw + n[2] * 0.1];
    const c1 = [s.x + u[0] * hw + n[0] * 0.1, s.y - hh, s.z + u[2] * hw + n[2] * 0.1];
    const c2 = [s.x + u[0] * hw + n[0] * 0.1, s.y + hh, s.z + u[2] * hw + n[2] * 0.1];
    const c3 = [s.x - u[0] * hw + n[0] * 0.1, s.y + hh, s.z - u[2] * hw + n[2] * 0.1];
    B.quad(c0, c1, c2, c3, { c: [0.1, 0.1, 0.12], e: [0, 0, 0], s: 0, uv: [[u0, 0], [u1, 0], [u1, 1], [u0, 1]], t: 1 });
  }

  return { mesh: B.build(), builder: B };
}

// One car into a Builder (shared by the static car mesh and the per-frame
// dynamic mesh). Forward is (sin yaw, -cos yaw); the mesh 'back' face
// (local -Z) points forward, so headlights go there and tail lights on
// the 'front' face (local +Z, the rear).
function addCarMesh(B, car) {
  const col = [parseInt(car.color.slice(1, 3), 16) / 255, parseInt(car.color.slice(3, 5), 16) / 255, parseInt(car.color.slice(5, 7), 16) / 255];
  // body
  B.box(car.x, 0.75, car.z, 4.4, 0.9, 2.0, car.yaw, {
    top: { c: shade(col, 1.1), s: 0.5 }, bottom: { c: [0.08, 0.08, 0.08] },
    front: { c: col, s: 0.5 }, back: { c: shade(col, 0.85), s: 0.5 },
    left: { c: shade(col, 0.9), s: 0.5 }, right: { c: shade(col, 0.95), s: 0.5 },
  }, ['bottom']);
  // cabin + windshield
  B.box(car.x, 1.5, car.z, 2.2, 0.7, 1.8, car.yaw, {
    top: { c: shade(col, 1.05), s: 0.6 }, bottom: { c: [0.08, 0.08, 0.08] },
    front: { c: [0.08, 0.1, 0.13], s: 0.9 }, back: { c: [0.08, 0.1, 0.13], s: 0.9 },
    left: { c: [0.1, 0.12, 0.15], s: 0.9 }, right: { c: [0.1, 0.12, 0.15], s: 0.9 },
  }, ['bottom']);
  // axle / wheels as one dark slab
  B.box(car.x, 0.35, car.z, 4.0, 0.7, 2.1, car.yaw, {
    top: { c: [0.08, 0.08, 0.08] }, bottom: { c: [0.05, 0.05, 0.05] },
    front: { c: [0.07, 0.07, 0.07] }, back: { c: [0.07, 0.07, 0.07] },
    left: { c: [0.07, 0.07, 0.07] }, right: { c: [0.07, 0.07, 0.07] },
  }, ['bottom']);
  // tail lights (emissive red, rear = local +Z — the mesh 'front'
  // face points backward, see the headlight note below)
  const fr = faceFrame({ x: car.x, z: car.z, w: 4.4, d: 2.0, yaw: car.yaw }, 'front');
  const pt = (uu, vv, oo) => [
    fr.o[0] + fr.u[0] * uu + fr.v[0] * vv + fr.n[0] * oo,
    fr.o[1] + fr.u[1] * uu + fr.v[1] * vv + fr.n[1] * oo,
    fr.o[2] + fr.u[2] * uu + fr.v[2] * vv + fr.n[2] * oo,
  ];
  B.quad(pt(-1.6, 0.75, 0.06), pt(-0.9, 0.75, 0.06), pt(-0.9, 1.05, 0.06), pt(-1.6, 1.05, 0.06),
    { c: [0.6, 0.05, 0.05], e: [0.9, 0.08, 0.06] });
  B.quad(pt(0.9, 0.75, 0.06), pt(1.6, 0.75, 0.06), pt(1.6, 1.05, 0.06), pt(0.9, 1.05, 0.06),
    { c: [0.6, 0.05, 0.05], e: [0.9, 0.08, 0.06] });
  // headlights (warm white lenses, front = local -Z — the mesh 'back'
  // face points along the car's forward. They glow at night via
  // uEmisBoost and stay dim in daylight.)
  const fh = faceFrame({ x: car.x, z: car.z, w: 4.4, d: 2.0, yaw: car.yaw }, 'back');
  const hp = (uu, vv, oo) => [
    fh.o[0] + fh.u[0] * uu + fh.v[0] * vv + fh.n[0] * oo,
    fh.o[1] + fh.u[1] * uu + fh.v[1] * vv + fh.n[1] * oo,
    fh.o[2] + fh.u[2] * uu + fh.v[2] * vv + fh.n[2] * oo,
  ];
  B.quad(hp(-1.6, 0.75, 0.06), hp(-0.9, 0.75, 0.06), hp(-0.9, 1.05, 0.06), hp(-1.6, 1.05, 0.06),
    { c: [0.9, 0.85, 0.6], e: [1.0, 0.9, 0.55] });
  B.quad(hp(0.9, 0.75, 0.06), hp(1.6, 0.75, 0.06), hp(1.6, 1.05, 0.06), hp(0.9, 1.05, 0.06),
    { c: [0.9, 0.85, 0.6], e: [1.0, 0.9, 0.55] });
  // drivable cars read at a glance: a small gold roof marker so the
  // player never wastes a try on a locked parked car
  if (car.kind === 'drivable') {
    B.box(car.x, 2.05, car.z, 0.9, 0.22, 0.9, car.yaw, {
      top: { c: [0.95, 0.76, 0.2], e: [0.9, 0.65, 0.1] }, bottom: { c: [0.2, 0.16, 0.05] },
      front: { c: [0.85, 0.66, 0.15], e: [0.7, 0.5, 0.08] }, back: { c: [0.85, 0.66, 0.15], e: [0.7, 0.5, 0.08] },
      left: { c: [0.85, 0.66, 0.15], e: [0.7, 0.5, 0.08] }, right: { c: [0.85, 0.66, 0.15], e: [0.7, 0.5, 0.08] },
    }, ['bottom']);
  }
}

// Cars: one dynamic buffer, ALL cars (parked + drivable + traffic) in one pass.
export function buildCarMesh(cars) {
  const B = new Builder();
  for (const car of cars) addCarMesh(B, car);
  return B.build();
}

// Headlight beam (Stage B): a smooth gradient cone + a ground light pool,
// rebuilt per frame from the driven car. Both use spc -2 (the beam branch
// of the shader, additive). NO stacked discs/billboards — the cone is one
// continuous tube whose alpha is a smooth function of distance along the
// beam (vUv.x = t, 0 at the car, 1 at the far end) and the view angle, and
// the pool's alpha is a smooth function of t and the lateral offset
// (vUv.y = -1..1 across the pool). There are no discrete rings to see.
// head = {x, z, yaw, intensity} — intensity scales with the preset
// (night 1.0, sunset 0.45, midday 0.12: nearly invisible in daylight).
export function buildBeamMesh(head, markers) {
  const B = new Builder();
  // marker beams: tall translucent columns (spc -2, additive), one per
  // marker — same beam branch as the headlight, alpha fading with height
  for (const m of markers || []) {
    const col = m.color;
    const H = 26, W = 1.1;
    for (let s = 0; s < 4; s++) {
      const a0 = (s / 4) * Math.PI * 2 + Math.PI / 4;
      const a1 = ((s + 1) / 4) * Math.PI * 2 + Math.PI / 4;
      const p = (a, y) => [m.x + Math.cos(a) * W, y, m.z + Math.sin(a) * W];
      B.quad(p(a0, 0.2), p(a1, 0.2), p(a1, H), p(a0, H), {
        c: col, e: col, s: -2,
        uv: [[0, 0], [0, 0], [1, 0], [1, 0]],
      });
    }
  }
  if (!head || head.intensity <= 0.01) return B.build();
  const fwd = [Math.sin(head.yaw), -Math.cos(head.yaw)];
  const right = [Math.cos(head.yaw), Math.sin(head.yaw)];
  const BEAM = [1.0, 0.93, 0.72];
  const emi = [BEAM[0] * head.intensity, BEAM[1] * head.intensity, BEAM[2] * head.intensity];
  const LEN = 30, RINGS = 10, SEGS = 10;
  // --- ground light pool: a trapezoid on the road, y just above the asphalt,
  // widening from 2 m at the bumper to 13 m at 30 m. Subdivided along its
  // length so the t-falloff is smooth, not one flat quad.
  const poolY = 0.14;
  for (let i = 0; i < RINGS; i++) {
    const t0 = i / RINGS, t1 = (i + 1) / RINGS;
    const d0 = t0 * LEN, d1 = t1 * LEN;
    const w0 = 1 + t0 * 5.5, w1 = 1 + t1 * 5.5;
    const c0 = [head.x + fwd[0] * d0, poolY, head.z + fwd[1] * d0];
    const c1 = [head.x + fwd[0] * d1, poolY, head.z + fwd[1] * d1];
    const a = [c0[0] - right[0] * w0, poolY, c0[2] - right[2] * w0];
    const b = [c0[0] + right[0] * w0, poolY, c0[2] + right[2] * w0];
    const c = [c1[0] + right[0] * w1, poolY, c1[2] + right[2] * w1];
    const d = [c1[0] - right[0] * w1, poolY, c1[2] - right[2] * w1];
    // uv.x = t (0 at the car), uv.y = lateral (-1 left edge .. 1 right edge)
    B.quad(a, b, c, d, {
      c: BEAM, e: emi, s: -2,
      uv: [[t0, -1], [t0, 1], [t1, 1], [t1, -1]],
    });
  }
  // --- volumetric cone: a tube of elliptical rings along the beam axis.
  // The axis stays at headlight height (y 0.85); the cone grows so its
  // lower edge meets the road a few metres out and its upper edge clears
  // a car roof 10 m ahead. One continuous surface, no discs.
  const rings = [];
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const d = 2 + t * (LEN - 2);
    const hw = 0.9 + t * 5.2;
    const hh = 0.45 + t * 2.1;
    const cx = head.x + fwd[0] * d, cz = head.z + fwd[1] * d;
    const pts = [];
    for (let j = 0; j < SEGS; j++) {
      const a = (j / SEGS) * Math.PI * 2;
      pts.push([
        cx + right[0] * Math.cos(a) * hw,
        0.85 + Math.sin(a) * hh,
        cz + right[2] * Math.cos(a) * hw,
      ]);
    }
    rings.push({ pts, t });
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const j1 = (j + 1) % SEGS;
      const a = rings[i].pts[j], b = rings[i].pts[j1];
      const c = rings[i + 1].pts[j1], d = rings[i + 1].pts[j];
      B.quad(a, b, c, d, {
        c: BEAM, e: emi, s: -2,
        uv: [[rings[i].t, 0], [rings[i].t, 0], [rings[i + 1].t, 0], [rings[i + 1].t, 0]],
      });
    }
  }
  return B.build();
}

// Mission / safehouse world markers + the E interaction radius ring.
// marker = {x, z, color, kind:'mission'|'safehouse'} — the floating
// diamond (opaque, emissive) sits above the target; the tall beam column
// for each marker is built by buildBeamMesh (additive pass). Mission
// yellow, safehouse pink — they never share one look.
// The E ring is a flat annulus on the ground around the near car (the
// 7 m interaction radius), so the player sees exactly how close to stand.
export function buildMarkerMesh(markers, eRing) {
  const B = new Builder();
  for (const m of markers || []) {
    const col = m.color;
    const emi = [col[0], col[1], col[2]];
    // floating diamond (two pyramids) above the target, bobbing is done
    // by the caller passing a y offset in m.y
    const y = m.y || 9;
    B.pyramid(m.x, y - 1.2, m.z, 2.2, 1.2, 2.2, 0.6, col, emi);
    B.pyramid(m.x, y + 1.2, m.z, 2.2, -1.2, 2.2, 0.6, col, emi);
    // ground ring under the target
    B.disc(m.x, 0.18, m.z, 3.2, 20, [0.05, 0.05, 0.05], [col[0] * 0.7, col[1] * 0.7, col[2] * 0.7]);
  }
  if (eRing) {
    // annulus: 24 segments, inner r 6.4, outer r 7.0, flat on the ground
    const segs = 24, r0 = 6.4, r1 = 7.0, y = 0.16;
    const col = [1.0, 0.85, 0.2];
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      B.quad(
        [eRing.x + Math.cos(a0) * r0, y, eRing.z + Math.sin(a0) * r0],
        [eRing.x + Math.cos(a0) * r1, y, eRing.z + Math.sin(a0) * r1],
        [eRing.x + Math.cos(a1) * r1, y, eRing.z + Math.sin(a1) * r1],
        [eRing.x + Math.cos(a1) * r0, y, eRing.z + Math.sin(a1) * r0],
        { c: col, e: [0.9, 0.7, 0.1], s: 0 },
      );
    }
  }
  return B.build();
}

// Mara on foot: coral jacket, dark trousers, skin head — distinct from the
// sidewalk pedestrians so the player always finds her.
export function buildMaraMesh(mara) {
  const B = new Builder();
  if (!mara) return B.build();
  const J = [0.85, 0.35, 0.3];
  B.box(mara.x, 1.05, mara.z, 0.6, 1.1, 0.4, mara.yaw, {
    top: { c: J }, bottom: { c: [0.15, 0.15, 0.15] },
    front: { c: J }, back: { c: shade(J, 0.85) },
    left: { c: shade(J, 0.9) }, right: { c: shade(J, 0.92) },
  }, ['bottom']);
  B.box(mara.x, 1.85, mara.z, 0.36, 0.38, 0.36, mara.yaw, {
    top: { c: [0.85, 0.68, 0.52] }, bottom: { c: [0.4, 0.3, 0.22] },
    front: { c: [0.82, 0.65, 0.5] }, back: { c: [0.78, 0.62, 0.48] },
    left: { c: [0.8, 0.64, 0.49] }, right: { c: [0.81, 0.64, 0.49] },
  }, ['bottom']);
  B.box(mara.x, 0.35, mara.z, 0.55, 0.7, 0.36, mara.yaw, {
    top: { c: [0.2, 0.2, 0.22] }, bottom: { c: [0.1, 0.1, 0.1] },
    front: { c: [0.18, 0.18, 0.2] }, back: { c: [0.18, 0.18, 0.2] },
    left: { c: [0.18, 0.18, 0.2] }, right: { c: [0.18, 0.18, 0.2] },
  }, ['bottom']);
  return B.build();
}

// Sky dome + sun + moon + stars, rebuilt per preset.
export function buildSkyMesh(preset) {
  const B = new Builder();
  const C = [1920, 0, 1728];
  const R = 4200;
  // dome: elevation rings from -4 deg to 90 deg
  const rings = 7, segs = 28;
  const horizon = preset.skyHorizon, zenith = preset.skyZenith;
  const ringPts = [];
  for (let r = 0; r < rings; r++) {
    const el = (-4 + (94 * r) / (rings - 1)) * Math.PI / 180;
    const t = Math.pow(Math.max(0, (el + 4 * Math.PI / 180) / (94 * Math.PI / 180)), 0.75);
    const col = [
      horizon[0] + (zenith[0] - horizon[0]) * t,
      horizon[1] + (zenith[1] - horizon[1]) * t,
      horizon[2] + (zenith[2] - horizon[2]) * t,
    ];
    const pts = [];
    for (let s = 0; s <= segs; s++) {
      const az = (s / segs) * Math.PI * 2;
      pts.push([
        C[0] + Math.cos(el) * Math.cos(az) * R,
        C[1] + Math.sin(el) * R,
        C[2] + Math.cos(el) * Math.sin(az) * R,
      ]);
    }
    ringPts.push({ pts, col });
  }
  // Sky quads with per-vertex colours: lower vertices take ring r's colour,
  // upper vertices ring r+1's, so the gradient is continuous — a single flat
  // colour per band shows a hard line across the sky.
  function skyQuad(a, b, c, d, colA, colB) {
    const n = [0, 1, 0], e = [0, 0, 0], uv = [0, 0];
    B.vert(a, n, colA, e, -1, uv, 0);
    B.vert(b, n, colA, e, -1, uv, 0);
    B.vert(c, n, colB, e, -1, uv, 0);
    B.vert(a, n, colA, e, -1, uv, 0);
    B.vert(c, n, colB, e, -1, uv, 0);
    B.vert(d, n, colB, e, -1, uv, 0);
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segs; s++) {
      const a = ringPts[r].pts[s], b = ringPts[r].pts[s + 1];
      const c = ringPts[r + 1].pts[s + 1], d = ringPts[r + 1].pts[s];
      // unlit: spc -1, colour interpolated between the two rings
      skyQuad(a, b, c, d, ringPts[r].col, ringPts[r + 1].col);
    }
  }
  // sun disc (fan), moon disc + halo, stars — all unlit (spc -1)
  function disc3D(dir, radius, col, emi) {
    const centre = [C[0] + dir[0] * (R - 60), dir[1] * (R - 60), C[2] + dir[2] * (R - 60)];
    const up = Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = v3norm(v3cross(dir, up));
    const v = v3norm(v3cross(u, dir));
    const segs2 = 18;
    let prev = null;
    for (let i = 0; i <= segs2; i++) {
      const a = (i / segs2) * Math.PI * 2;
      const p = [
        centre[0] + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * radius,
        centre[1] + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * radius,
        centre[2] + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * radius,
      ];
      if (prev) B.tri(centre, prev, p, { c: col, e: emi, s: -1 });
      prev = p;
    }
  }
  if (preset.sun) {
    const az = preset.sun.az, el = preset.sun.el;
    const dir = [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
    disc3D(dir, preset.sun.r, [0, 0, 0], preset.sun.col);
  }
  if (preset.moon) {
    const az = preset.moon.az, el = preset.moon.el;
    const dir = [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
    disc3D(dir, preset.moon.r * 2.1, [0, 0, 0], [0.1, 0.12, 0.18]); // halo
    disc3D(dir, preset.moon.r, [0, 0, 0], preset.moon.col);
  }
  if (preset.stars) {
    const rnd = mulberry32(99);
    for (let i = 0; i < 220; i++) {
      const az = rnd() * Math.PI * 2;
      const el = (0.12 + rnd() * 0.85) * Math.PI / 2;
      const dir = [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
      const s = 7 + rnd() * 10;
      const centre = [C[0] + dir[0] * (R - 80), dir[1] * (R - 80), C[2] + dir[2] * (R - 80)];
      const up = [0, 1, 0];
      const u = v3norm(v3cross(dir, up));
      const v = v3norm(v3cross(u, dir));
      const b = 0.55 + rnd() * 0.45;
      const emi = [b, b, b * 1.05];
      B.quad(
        [centre[0] - u[0] * s - v[0] * s, centre[1] - u[1] * s - v[1] * s, centre[2] - u[2] * s - v[2] * s],
        [centre[0] + u[0] * s - v[0] * s, centre[1] + u[1] * s - v[1] * s, centre[2] + u[2] * s - v[2] * s],
        [centre[0] + u[0] * s + v[0] * s, centre[1] + u[1] * s + v[1] * s, centre[2] + u[2] * s + v[2] * s],
        [centre[0] - u[0] * s + v[0] * s, centre[1] - u[1] * s + v[1] * s, centre[2] - u[2] * s + v[2] * s],
        { c: [0, 0, 0], e: emi, s: -1 },
      );
    }
  }
  return B.build();
}

export { rectCorners };
