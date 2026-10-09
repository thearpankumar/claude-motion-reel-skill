// Scaffold a motion-reel project (Windows, macOS and Linux; no sh needed):
//   node <skill>/scripts/init.mjs videos/<slug> [--preset <name|path>]
// Copies the engine (film/), the pipeline scripts (scripts/) and the templates (brief, timeline, docs) into a NEW folder.
// Refuses an existing non-empty folder: parallel sessions often pick the same slug. Pick a distinctive one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const destArg = args[0];
if (!destArg || destArg.startsWith('--')) { console.error('usage: node init.mjs <project-dir> [--preset <name|path>]   e.g. videos/acme-launch --preset blank'); process.exit(1); }
const DEST = path.resolve(destArg);
const pi = args.indexOf('--preset');
let PRESET = '';
if (pi > 0) {
  const p = args[pi + 1] || '';
  // a path, or a bare name looked up in ./presets/ then in the skill's own presets/
  for (const c of [p, path.join('presets', p), path.join(SKILL, 'presets', p), path.join(SKILL, 'presets', path.basename(p))]) {
    if (fs.existsSync(path.join(c, 'preset.jsonc'))) { PRESET = path.resolve(c); break; }
  }
  if (!PRESET) { console.error(`no preset '${p}' (looked in ./presets and ${path.join(SKILL, 'presets')})`); process.exit(1); }
}
if (fs.existsSync(DEST) && fs.readdirSync(DEST).length) {
  console.error(`REFUSING: ${destArg} exists and is not empty (another session may own it). Choose a new slug.`); process.exit(2);
}
for (const d of ['film/lib', 'scripts', 'docs', 'audio/vo', 'assets/fonts', 'assets/brand', 'assets/cap', 'renders', 'review']) fs.mkdirSync(path.join(DEST, d), { recursive: true });
const cp = (from, to) => fs.copyFileSync(path.join(SKILL, from), path.join(DEST, to));
for (const f of ['index.html', 'core.js', 'type.js', 'film.js']) cp(`engine/${f}`, `film/${f}`);
for (const f of ['motion.js', 'motion.test.js']) cp(`engine/lib/${f}`, `film/lib/${f}`);
for (const f of ['render.mjs', 'sync.mjs', 'sfx.mjs', 'capture.mjs', 'beats.py', 'music.py', 'vo.py', 'mix.py', 'review.py', 'preset.mjs']) cp(`scripts/${f}`, `scripts/${f}`);
cp('templates/brief.md', 'brief.md'); cp('templates/timeline.json', 'timeline.json');
for (const f of fs.readdirSync(path.join(SKILL, 'templates/docs'))) if (f.endsWith('.md')) cp(`templates/docs/${f}`, `docs/${f}`);
fs.writeFileSync(path.join(DEST, '.owner'), `created ${new Date().toISOString()} by motion-reel init\n`);

const sh = (cmd, a, cwd = DEST) => spawnSync(cmd, a, { cwd, encoding: 'utf8' });
if (PRESET) {
  const r = spawnSync(process.execPath, [path.join(SKILL, 'scripts/preset.mjs'), PRESET, DEST], { stdio: 'inherit' });
  if (r.status) process.exit(r.status);
}
// rendering needs playwright: if this project can't resolve it, link the copy install put next to the skill (junction: no admin needed on Windows)
const canResolve = () => sh(process.execPath, ['-e', "require.resolve('playwright',{paths:[process.cwd()]})"]).status === 0;
if (!canResolve() && fs.existsSync(path.join(SKILL, 'node_modules/playwright'))) {
  fs.symlinkSync(path.join(SKILL, 'node_modules'), path.join(DEST, 'node_modules'), 'junction');
  console.log('linked playwright from the skill install');
}
console.log(`scaffolded ${destArg}`);
// toolchain checks (warn, don't fail)
if (sh('ffmpeg', ['-version']).status !== 0) console.log('WARN: ffmpeg not on PATH');
if (!canResolve()) console.log(`WARN: playwright not resolvable from ${destArg} → run: npm i -D playwright && npx playwright install chromium`);
// the interpreter that has the audio libraries: Windows has `python` (the `python3` Store stub never works), macOS/Linux have `python3`
const pyCandidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
const py = pyCandidates.find((c) => sh(c, ['-c', 'import numpy, scipy, soundfile, librosa, PIL']).status === 0);
if (py) {
  fs.writeFileSync(path.join(DEST, '.python'), py + '\n');
  console.log(`python command for this film: ${py}  (written to .python; use it wherever the docs say "python")`);
} else console.log('WARN: python deps missing → python -m pip install numpy scipy soundfile librosa pillow (use python3 on macOS/Linux)');
if (sh(process.execPath, ['film/lib/motion.test.js']).status === 0) console.log('motion.js tests pass');
if (sh(process.execPath, ['scripts/sync.mjs']).status === 0) console.log('film/data.js written (nominal grid until beats.json exists)');
console.log('next: fill brief.md, then follow SKILL.md step 2 (assets)');
