// Smoke test (any OS): scaffold a film with a preset, make a few seconds of music + SFX, and render it.
//   npm test        or        make test        or        node install/test-render.mjs [preset-dir] [seconds]
// Output: videos/_test-<time>/renders/<format>.mp4
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join(KIT, '.claude/skills/motion-reel');
const preset = process.argv[2] || 'presets/blank';
const secs = +(process.argv[3] || 5);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const slug = path.join('videos', `_test-${stamp}`);
const run = (cmd, args, cwd = KIT, quiet = false) => {
  const opts = { cwd, stdio: quiet ? 'ignore' : 'inherit' };
  // npm/npx are .cmd shims on Windows and need a shell (one command string, no args array)
  const r = process.platform === 'win32' && /^np[mx]$/.test(cmd) ? spawnSync([cmd, ...args].join(' '), { ...opts, shell: true }) : spawnSync(cmd, args, opts);
  return r.status === 0;
};
const must = (ok, msg) => { if (!ok) { console.error(msg); process.exit(1); } };

// playwright: use the kit's own devDependency (npm install) when it isn't resolvable yet
if (!run(process.execPath, ['-e', "require.resolve('playwright')"], KIT, true)) {
  console.log('installing playwright + chromium for the test...');
  must(run('npm', ['install', '--silent', '--no-audit', '--no-fund']), 'npm install failed');
  must(run('npx', ['--yes', 'playwright', 'install', 'chromium']), 'playwright install failed');
}

must(run(process.execPath, [path.join(SKILL, 'scripts/init.mjs'), slug, '--preset', preset]), 'scaffold failed');
const proj = path.join(KIT, slug);
// shorten the starter timeline to the test length
const tlFile = path.join(proj, 'timeline.json'), TL = JSON.parse(fs.readFileSync(tlFile, 'utf8'));
TL.duration = secs; TL.formats = [TL.formats[0]];
fs.writeFileSync(tlFile, JSON.stringify(TL, null, 2));

const py = (process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']).find((c) => run(c, ['-c', 'import numpy, scipy, soundfile, librosa'], proj, true));
if (py) {
  must(run(py, ['scripts/music.py'], proj), 'music.py failed');
  must(run(py, ['scripts/beats.py', 'audio/music.wav', '--stem', 'audio/drums.wav'], proj), 'beats.py failed');
  must(run(process.execPath, ['scripts/sync.mjs'], proj, true), 'sync failed');
  must(run(process.execPath, ['scripts/sfx.mjs'], proj), 'sfx failed');
  must(run(py, ['scripts/mix.py'], proj), 'mix.py failed');
} else {
  console.log('WARN: python deps missing (pip install -r requirements.txt) -> rendering without sound');
  must(run(process.execPath, ['scripts/sync.mjs'], proj, true), 'sync failed');
}
must(run(process.execPath, ['scripts/render.mjs'], proj), 'render failed');
console.log(`OK: ${path.join(slug, 'renders', TL.formats[0] + '.mp4')}`);
