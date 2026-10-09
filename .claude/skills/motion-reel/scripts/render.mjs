// Render the film: drives window.seek(t) in headless Chromium, pipes frames to ffmpeg. Run from the project root.
//
//   node scripts/render.mjs --sheet [--fmt 9x16] [--phase 0.25]  one frame per beat → review/sheets/sheet_<fmt>.jpg (+ _phone.jpg at 360 px)
//   node scripts/render.mjs --at 1.2,3.4 [--fmt 1x1]              stills → review/stills/<fmt>/t<sec>.png
//   node scripts/render.mjs --draft [--all]                       30 fps, no blur, CRF 22 → renders/draft_<fmt>.mp4 (for review rounds)
//   node scripts/render.mjs [--fmt 16x9 | --all]                  final: 60 fps, adaptive 180° motion blur, H.264 yuv420p CRF 16 → renders/<fmt>.mp4
//   node scripts/render.mjs --range 3,5 [--blur 0]                a clip of seconds 3–5 → renders/clip_<fmt>_3-5.mp4 (motion checks)
//   node scripts/render.mjs --mux [--all]                         re-mux the current audio/mix.wav into existing renders without re-rendering
//   node scripts/render.mjs --verify [--all]                      determinism check: 12 probes, cold vs after seeking elsewhere
//   options: --fps N  --blur 0|1 (default 1 for finals)  --crf N  --audio path (default audio/mix.wav if present)
//
// GPU FIRST, CPU FALLBACK (automatic, on any machine):
//   painting  Chromium is launched with GPU rasterization. If it finds no real GPU (software renderer), or the GPU does not
//             paint identical pixels cold vs after seeking elsewhere (the seek(t) contract), it relaunches on the CPU.
//   encoding  the first hardware H.264 encoder that really works is used (NVIDIA NVENC, Intel QSV, AMD AMF, Apple
//             VideoToolbox, Linux VAAPI), constant-quality matched to the CRF; otherwise libx264 on the CPU. If a hardware
//             encode fails mid-run, that format is redone on libx264.
//   control   --gpu auto|on|off (default auto)   --encoder auto|cpu|<ffmpeg encoder name>   (env: MOTION_GPU, MOTION_ENCODER)
//   The chosen backend is printed at the start of every run. Draft, sheets and finals of one film should use the same backend.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, 'package.json'));
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.error('playwright not found from this project. Run: npm i -D playwright && npx playwright install chromium'); process.exit(1);
}

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const has = (k) => argv.includes(`--${k}`);
const TL = JSON.parse(fs.readFileSync(path.join(ROOT, 'timeline.json'), 'utf8'));
const SIZES = { '16x9': [1920, 1080], '1x1': [1080, 1080], '4x5': [1080, 1350], '9x16': [1080, 1920] };
const FORMATS = has('all') ? TL.formats : [opt('fmt', TL.formats[0])];
const DRAFT = has('draft');
const AUDIO = path.resolve(ROOT, opt('audio', 'audio/mix.wav'));
const hasAudio = fs.existsSync(AUDIO);
const mkdir = (d) => fs.mkdirSync(d, { recursive: true });
const run = (cmd, a) => { const r = spawnSync(cmd, a, { stdio: ['ignore', 'inherit', 'pipe'] }); if (r.status) throw new Error(`${cmd} failed: ${r.stderr}`); return r; };

// ------------------------------------------------------------------ GPU first, CPU fallback
const flag = (name, env, d) => { const v = String(opt(name, process.env[env] || d)); return v === 'true' ? 'on' : v; };
const GPU_MODE = flag('gpu', 'MOTION_GPU', 'auto');            // auto | on | off
const ENC_MODE = flag('encoder', 'MOTION_ENCODER', 'auto');    // auto | cpu | an ffmpeg encoder name
const HW_ENCODERS = ({ darwin: ['h264_videotoolbox'], win32: ['h264_nvenc', 'h264_qsv', 'h264_amf'], linux: ['h264_nvenc', 'h264_vaapi', 'h264_qsv', 'h264_amf'] })[process.platform] || [];
// ffmpeg args for one H.264 encoder at constant quality q (the CRF value). `pre` goes before the inputs.
function encoderArgs(enc, q, draft) {
  const Q = String(q), c = ['-c:v', enc];
  switch (enc) {
    case 'h264_nvenc': return { pre: [], post: [...c, '-preset', draft ? 'p3' : 'p6', '-rc', 'vbr', '-cq', Q, '-b:v', '0', '-pix_fmt', 'yuv420p', '-profile:v', 'high'] };
    case 'h264_qsv': return { pre: [], post: [...c, '-preset', draft ? 'fast' : 'slow', '-global_quality', Q, '-pix_fmt', 'yuv420p', '-profile:v', 'high'] };
    case 'h264_amf': return { pre: [], post: [...c, '-quality', draft ? 'speed' : 'quality', '-rc', 'cqp', '-qp_i', Q, '-qp_p', Q, '-qp_b', Q, '-pix_fmt', 'yuv420p', '-profile:v', 'high'] };
    case 'h264_videotoolbox': return { pre: [], post: [...c, '-q:v', String(Math.max(1, Math.min(100, Math.round(100 - q * 2)))), '-pix_fmt', 'yuv420p', '-profile:v', 'high'] };
    case 'h264_vaapi': return { pre: ['-vaapi_device', process.env.MOTION_VAAPI_DEVICE || '/dev/dri/renderD128'], post: ['-vf', 'format=nv12,hwupload', ...c, '-qp', Q, '-profile:v', 'high'] };
    default: return { pre: [], post: [...c, '-pix_fmt', 'yuv420p'] };
  }
}
// first hardware encoder that is listed AND completes a real test encode on this machine; null → libx264 on the CPU
function pickEncoder() {
  if (ENC_MODE === 'cpu' || ENC_MODE === 'off') return null;
  const listed = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '';
  for (const e of ENC_MODE === 'auto' || ENC_MODE === 'on' ? HW_ENCODERS : [ENC_MODE]) {
    if (!listed.includes(e)) continue;
    const { pre, post } = encoderArgs(e, 20, true);
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...pre, '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=0.3', ...post, '-f', 'null', '-'], { encoding: 'utf8' });
    if (r.status === 0) return e;
  }
  return null;
}
let ENC_PICKED;                                                 // undefined = not probed yet (sheets/stills never need it)
const getEncoder = () => (ENC_PICKED === undefined ? (ENC_PICKED = pickEncoder()) : ENC_PICKED);

// ------------------------------------------------------------------ --mux: new mix into existing renders, video untouched
if (has('mux')) {
  if (!hasAudio) { console.error('no audio at', AUDIO); process.exit(1); }
  for (const fmt of FORMATS) {
    const src = path.join(ROOT, `renders/${fmt}.mp4`), tmp = src + '.tmp.mp4';
    run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-i', AUDIO, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-shortest', '-movflags', '+faststart', tmp]);
    fs.renameSync(tmp, src); console.log('muxed', src);
  }
  process.exit(0);
}

// ------------------------------------------------------------------ static server (film fetches nothing; data.js is generated)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wav': 'audio/wav', '.mp4': 'video/mp4' };
const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }   // new headless Chromium asks for one; keep the log clean
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE_ARGS = ['--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none', '--disable-gpu-vsync'];
let browser, BACKEND = 'CPU';
// GPU: the "chromium" channel is Chromium's new headless mode, which can use the GPU (the default headless shell is software only).
// CPU: the default headless shell, which paints with the SwiftShader software renderer.
const launchBrowser = (gpu) => (gpu ? chromium.launch({ channel: 'chromium', args: [...BASE_ARGS, '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] }) : chromium.launch({ args: BASE_ARGS }));
async function gpuName(b) {                                     // the real GPU's name, or null when Chromium fell back to a software renderer
  const pg = await b.newPage();
  try {
    return await pg.evaluate(() => {
      const g = document.createElement('canvas').getContext('webgl'); if (!g) return null;
      const e = g.getExtension('WEBGL_debug_renderer_info'), r = e ? String(g.getParameter(e.UNMASKED_RENDERER_WEBGL)) : '';
      return /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(r) || !r ? null : r.replace(/^ANGLE \((.*)\)$/, '$1');
    });
  } finally { await pg.close(); }
}
async function gpuIsDeterministic(fmt) {                        // the seek(t) contract on this GPU: a frame repaints identically after seeking elsewhere
  const F = await openFilm(fmt);
  try {
    const probes = [0.37, 0.91, 0.58, 0.14].map((k) => +(k * F.DUR).toFixed(3));
    const cold = []; for (const t of probes) cold.push(decodePNG(await F.png(t)));
    for (let k = probes.length - 1; k >= 0; k--) {
      await F.png(probes[(k + 2) % probes.length]);
      const again = decodePNG(await F.png(probes[k]));
      for (let q = 0; q < again.length; q += 13) if (Math.abs(again[q] - cold[k][q]) > 2) return false;
    }
    return true;
  } finally { await F.page.close(); }
}
async function startBrowser() {
  if (GPU_MODE !== 'off') {
    try {
      browser = await launchBrowser(true);
      const name = await gpuName(browser);
      if (!name) console.log('[render] no GPU available to Chromium here → painting on the CPU');
      else if (!(await gpuIsDeterministic(FORMATS[0]))) console.log(`[render] GPU (${name}) does not repaint identical frames → painting on the CPU`);
      else { BACKEND = `GPU (${name})`; return; }
    } catch (e) { console.log(`[render] GPU browser unavailable (${String(e.message).split('\n')[0]}) → painting on the CPU`); }
    try { await browser?.close(); } catch {}
  }
  browser = await launchBrowser(false);
}

// minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) → packed RGB
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG'); }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : (() => { throw new Error('PNG colour type ' + ct); })();
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const A = x >= bpp ? cur[x - bpp] : 0, B = prev[x], Cc = x >= bpp ? prev[x - bpp] : 0; let v = row[x];
      if (f === 1) v += A; else if (f === 2) v += B; else if (f === 3) v += (A + B) >> 1;
      else if (f === 4) { const pp = A + B - Cc, pa = Math.abs(pp - A), pb = Math.abs(pp - B), pc = Math.abs(pp - Cc); v += pa <= pb && pa <= pc ? A : pb <= pc ? B : Cc; }
      cur[x] = v & 255;
    }
    for (let x = 0, o = y * w * 3; x < w; x++, o += 3) { const q = x * bpp; out[o] = cur[q]; out[o + 1] = cur[q + 1]; out[o + 2] = cur[q + 2]; }
    cur.copy(prev);
  }
  return out;
}

async function openFilm(fmt) {
  const [W, H] = SIZES[fmt];
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
  page.on('pageerror', (e) => { console.error('[pageerror]', e.message); process.exitCode = 1; });
  await page.goto(`http://127.0.0.1:${server.address().port}/film/index.html?fmt=${fmt}`);
  await page.waitForFunction(() => window.READY, null, { timeout: 120000 });
  await page.evaluate(() => window.READY);
  const cdp = await page.context().newCDPSession(page);
  const info = await page.evaluate(() => ({ DUR: window.DURATION, FPS: window.FPS, CUTS: window.CUTS || [], BEATS: window.BEATS || {} }));
  const png = async (t) => {
    await page.evaluate((t) => window.seek(t), t);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    return Buffer.from(data, 'base64');
  };
  return { page, png, W, H, ...info };
}

function ffmpeg(a) {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((ok, bad) => p.on('close', (c) => (c ? bad(new Error(`ffmpeg exit ${c}`)) : ok())));
  done.catch(() => {}); p.stdin.on('error', () => {});          // a failed encoder is reported by the caller, never as an unhandled rejection
  return { p, done };
}
// back-pressure aware write that notices an ffmpeg that already died (a hardware encoder can refuse mid-run)
const write = async (p, buf) => {
  if (p.exitCode !== null) throw new Error('ffmpeg exited early');
  if (!p.stdin.write(buf)) await Promise.race([new Promise((r) => p.stdin.once('drain', r)), new Promise((_, j) => p.once('close', () => j(new Error('ffmpeg exited early'))))]);
};

await startBrowser();
console.log(`[render] painting: ${BACKEND}`);

for (const fmt of FORMATS) {
  const F = await openFilm(fmt);
  const t0 = Date.now();

  if (has('sheet')) {
    // one frame per beat, a quarter-beat after the hit so the reaction is visible
    const phase = +opt('phase', 0.25);
    const grid = F.BEATS.beats && F.BEATS.beats.length ? F.BEATS.beats : [];
    const period = F.BEATS.beat || 60 / TL.bpm;
    const beatT = (i) => grid[i] ?? (grid.length ? grid[grid.length - 1] + (i - grid.length + 1) * period : i * period);
    const times = [];
    for (let i = 0; beatT(i) < F.DUR - 0.5 / F.FPS; i++) times.push(Math.min(F.DUR - 1 / F.FPS, beatT(i) + phase * period));
    const dir = path.join(ROOT, 'review/sheets', fmt); mkdir(dir);
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    for (let i = 0; i < times.length; i++) fs.writeFileSync(path.join(dir, `b${String(i).padStart(3, '0')}.png`), await F.png(times[i]));
    fs.writeFileSync(path.join(dir, 'times.json'), JSON.stringify(times));
    const wide = F.W >= F.H, cols = wide ? 8 : 10, rows = Math.ceil(times.length / cols);
    for (const [tag, tw] of [['', wide ? 480 : 270], ['_phone', 360]]) {
      const th = Math.round(tw * F.H / F.W / 2) * 2, c = tag ? (wide ? 5 : 8) : cols, r = Math.ceil(times.length / c);
      const label = `drawtext=text='b%{frame_num}':x=6:y=6:fontsize=${tag ? 16 : 20}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4,`;
      const out = path.join(ROOT, `review/sheets/sheet_${fmt}${tag}.jpg`);
      const argsFor = (lab) => ['-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(dir, 'b%03d.png'), '-vf', `scale=${tw}:${th}:flags=lanczos,${lab}tile=${c}x${r}:padding=6:color=0x202020`, '-frames:v', '1', '-q:v', '3', out];
      if (spawnSync('ffmpeg', argsFor(label)).status) run('ffmpeg', argsFor(''));   // ffmpeg without drawtext: unlabeled
      console.log('wrote', path.relative(ROOT, out), `(${times.length} beats, ${rows} rows)`);
    }
  } else if (has('verify')) {
    // determinism: every probe time must paint identical pixels cold and after seeking elsewhere (in any order)
    const probes = Array.from({ length: 12 }, (_, i) => +((i + 0.37) * F.DUR / 12).toFixed(3));
    const cold = [];
    for (const t of probes) cold.push(decodePNG(await F.png(t)));
    let bad = 0;
    for (let k = probes.length - 1; k >= 0; k--) {
      await F.png(probes[(k * 7 + 3) % probes.length]);                // disturb: seek somewhere else first
      const again = decodePNG(await F.png(probes[k]));
      let d = 0; for (let q = 0; q < again.length; q += 13) d = Math.max(d, Math.abs(again[q] - cold[k][q]));
      if (d > 2) { bad++; console.log(`NOT DETERMINISTIC at t=${probes[k]}s (max pixel diff ${d})`); }
    }
    console.log(bad ? `${bad}/${probes.length} probes differ — state is leaking between frames` : `deterministic: ${probes.length}/${probes.length} probes identical (${fmt})`);
    if (bad) process.exitCode = 1;
  } else if (has('at')) {
    const dir = path.join(ROOT, 'review/stills', fmt); mkdir(dir);
    for (const t of String(opt('at', '0')).split(',').map(Number)) {
      const f = path.join(dir, `t${t.toFixed(3)}.png`); fs.writeFileSync(f, await F.png(t)); console.log('wrote', path.relative(ROOT, f));
    }
  } else {
    const fps = +opt('fps', DRAFT ? 30 : F.FPS);
    const blur = !DRAFT && String(opt('blur', '1')) !== '0';
    const [a, b] = has('range') ? String(opt('range')).split(',').map(Number) : [0, F.DUR];
    const out = path.join(ROOT, 'renders', has('range') ? `clip_${fmt}_${a}-${b}.mp4` : `${DRAFT ? 'draft_' : ''}${fmt}.mp4`);
    mkdir(path.dirname(out));
    const withAudio = hasAudio && !has('range');
    const crf = +opt('crf', DRAFT ? 22 : 16);
    const encode = async (enc) => {
    const v = enc ? encoderArgs(enc, crf, DRAFT)
      : { pre: [], post: ['-c:v', 'libx264', '-preset', DRAFT ? 'veryfast' : 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high'] };
    console.log(`[render] encoding: ${enc ? enc + ' (GPU/hardware)' : 'libx264 (CPU)'}`);
    const t0 = Date.now();
    const { p, done } = ffmpeg([
      ...v.pre,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${F.W}x${F.H}`, '-framerate', String(fps), '-probesize', '100M', '-i', '-',
      ...(withAudio ? ['-i', AUDIO] : []),
      ...v.post,
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      ...(withAudio ? ['-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '320k', '-shortest'] : []),
      '-movflags', '+faststart', out,
    ]);
    // Adaptive 180° motion blur: each frame is probed at two shutter points; the mean pixel difference sets how many
    // sub-frames to average (2 when static → 24 on the fastest moves). Sub-frames sit symmetrically around the frame
    // time and never straddle a hard cut (window.CUTS), so a cut is never double-exposed.
    const SHUTTER = 0.5, MIN_SUB = 2, MAX_SUB = 24;
    const clampCut = (tc, ts) => {
      for (const c of F.CUTS) {
        if (tc < c && ts >= c) return c - 1e-4;
        if (ts < c && tc >= c) return c;
      }
      return ts;
    };
    const at = (tc, u) => clampCut(tc, Math.max(0, Math.min(F.DUR - 1e-6, tc + (u - 0.5) * SHUTTER / fps)));
    const N = Math.round((b - a) * fps), acc = new Float32Array(F.W * F.H * 3), buf = Buffer.alloc(F.W * F.H * 3), hist = {};
    for (let i = 0; i < N; i++) {
      const tc = a + i / fps;
      if (!blur) { await write(p, Buffer.from(decodePNG(await F.png(tc)))); }
      else {
        const x = decodePNG(await F.png(at(tc, 0.25))), y = decodePNG(await F.png(at(tc, 0.75)));
        let d = 0; for (let q = 0; q < x.length; q += 97) d += Math.abs(x[q] - y[q]); d /= x.length / 97;
        const SUB = d < 0.35 ? MIN_SUB : Math.min(MAX_SUB, Math.max(4, Math.round(4 + d * 1.6)));
        hist[SUB] = (hist[SUB] || 0) + 1;
        acc.fill(0);
        const add = (im) => { for (let q = 0; q < acc.length; q++) acc[q] += im[q]; };
        if (SUB === 2) { add(x); add(y); } else for (let k = 0; k < SUB; k++) add(decodePNG(await F.png(at(tc, (k + 0.5) / SUB))));
        for (let q = 0; q < acc.length; q++) buf[q] = Math.min(255, Math.round(acc[q] / SUB));
        await write(p, buf);
      }
      if (i % 60 === 0) process.stdout.write(`\r${fmt} frame ${i}/${N}  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
    }
    p.stdin.end(); await done;
    console.log(`\nwrote ${path.relative(ROOT, out)}  ${N} frames @ ${fps} fps${blur ? '  sub-frames ' + JSON.stringify(hist) : ''}${withAudio ? '  + ' + path.relative(ROOT, AUDIO) : '  (silent)'}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    };
    // hardware encoder first; if it refuses (driver limits, session caps) this format is redone on libx264 and later ones stay on the CPU
    const enc = getEncoder();
    try { await encode(enc); }
    catch (e) {
      if (!enc) throw e;
      console.log(`\n[render] ${enc} failed (${String(e.message).split('\n')[0]}) → redoing ${fmt} on libx264 (CPU)`);
      ENC_PICKED = null; await encode(null);
    }
  }
  await F.page.close();
}
await browser.close(); server.close();
