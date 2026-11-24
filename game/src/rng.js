// Seeded RNG (mulberry32) — deterministic city generation, seed 20261123.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function range(rnd, lo, hi) {
  return lo + rnd() * (hi - lo);
}

export function rangeInt(rnd, lo, hi) {
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

export function pick(rnd, arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

export function chance(rnd, p) {
  return rnd() < p;
}

// Deterministic jitter: same input -> same output, independent of call order.
export function hash2(x, z, seed) {
  let h = (seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
