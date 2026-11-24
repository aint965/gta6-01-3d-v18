// Headless driver (Stage A): serves the repo, drives chrome-headless-shell
// directly via its CLI (--screenshot / --dump-dom) — no CDP, no puppeteer.
// Captures console/page/network errors from chrome's stderr logging and 4
// screenshots into screenshots/. Exits non-zero on any error.
// Usage: node checks/drive.mjs [port]
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const PORT = Number(process.argv[2] || 8128);
const CHROME = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const SHOTS = [
  { name: '1-boulevard-day.jpg', shot: 'day' },
  { name: '2-sunset-street.jpg', shot: 'sunset' },
  { name: '3-night.jpg', shot: 'night' },
  { name: '4-plaza.jpg', shot: 'plaza' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const errors = [];
const server = spawn('node', ['serve.ts', '--port', String(PORT)], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => {
  const line = d.toString().trim();
  // ignore Node's harmless MODULE_TYPELESS_PACKAGE_JSON warning about the
  // kit's serve.ts; only real server failures count
  if (/MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module|performance overhead|trace-warnings/.test(line)) return;
  if (/Error|EADDRINUSE|failed/i.test(line)) errors.push('server stderr: ' + line);
});

function chrome(args, timeoutMs = 200000) {
  return new Promise((resolve, reject) => {
    const p = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('chrome timeout: ' + args.join(' '))); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

function scanChromeLog(err, label) {
  // chrome --enable-logging=stderr writes console messages as CONSOLE lines
  for (const line of err.split('\n')) {
    if (!line.includes('CONSOLE')) continue;
    if (/Uncaught|Error|Failed to load|net::ERR/i.test(line)) errors.push(`${label}: ${line.trim().slice(0, 300)}`);
  }
}

try {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`);
      if (r.ok) break;
    } catch { /* retry */ }
    await sleep(250);
  }

  mkdirSync(join(repo, 'screenshots'), { recursive: true });
  const baseFlags = [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--window-size=1280,720', '--enable-logging=stderr', '--v=0',
  ];
  for (const s of SHOTS) {
    const url = `http://127.0.0.1:${PORT}/?shot=${s.shot}&seed=1`;
    const path = join(repo, 'screenshots', s.name);
    const r = await chrome([
      ...baseFlags, '--virtual-time-budget=1000',
      `--screenshot=${path}`, url,
    ]);
    scanChromeLog(r.err, s.shot);
    if (!existsSync(path)) {
      errors.push(`${s.name}: screenshot file missing (chrome exit ${r.code})`);
      continue;
    }
    const size = statSync(path).size;
    console.log(`${s.name}: ${size} bytes, shot=${s.shot}`);
    if (size > 262144) errors.push(`${s.name} over 256 KiB: ${size}`);
    if (size < 5000) errors.push(`${s.name} suspiciously small: ${size} bytes (page may not have rendered)`);
  }

  // probe run: dump the DOM after virtual time, read the #probe div
  const probe = await chrome([
    ...baseFlags, '--virtual-time-budget=1000', '--dump-dom',
    `http://127.0.0.1:${PORT}/?shot=day&seed=1`,
  ]);
  scanChromeLog(probe.err, 'probe');
  const m = probe.out.match(/<div id="probe"[^>]*>/);
  if (!m) {
    errors.push('probe div missing — the game did not reach 3 frames');
  } else {
    const tag = m[0];
    const errM = tag.match(/data-errors="([^"]*)"/);
    const infoM = tag.match(/data-info="([^"]*)"/);
    if (errM) {
      const list = JSON.parse(errM[1].replace(/&quot;/g, '"'));
      for (const e of list) errors.push('page error: ' + e);
    }
    if (infoM) {
      const info = JSON.parse(infoM[1].replace(/&quot;/g, '"'));
      console.log(`gameInfo: staticVerts=${info.staticVerts} carVerts=${info.carVerts} buildings=${info.counts.buildings}`);
    }
  }
} finally {
  server.kill('SIGTERM');
}

console.log(`errors: ${errors.length}`);
for (const e of errors) console.log('  FAIL ' + e);
if (errors.length > 0) {
  console.log('DRIVE: FAIL');
  process.exit(1);
}
console.log('DRIVE: 4/4 shots OK, 0 console errors');
