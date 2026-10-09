#!/bin/sh
# Motion Reel Kit installer for macOS and Linux. Makes /motion-reel available in EVERY Claude Code project.
# (Windows: install/install.ps1. Or just run `make install`, which picks the right one.)
#
#   sh install/install.sh                    install for your user (~/.claude/skills/motion-reel)
#   sh install/install.sh --project <dir>    install into one project only (<dir>/.claude/skills/motion-reel)
#
# It copies the skill + presets, installs Playwright + Chromium next to the skill, and installs the Python audio
# libraries. Safe to re-run: an existing install is moved to a backup OUTSIDE the skills folder (a backup inside it
# would load as a second, duplicate skill).
set -e
KIT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$1" = "--project" ]; then
  [ -d "$2" ] || { echo "no such folder: $2"; exit 1; }
  BASE="$(cd "$2" && pwd)/.claude"
else
  BASE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
fi
DEST="$BASE/skills/motion-reel"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  ✓ %s\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; }

say "1/4  Checking tools"
command -v node >/dev/null || { echo "Node is missing. Install Node 22+ (macOS: brew install node) and re-run."; exit 1; }
command -v npm >/dev/null || { echo "npm is missing. It ships with Node: reinstall Node 22+ and re-run."; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 20 ] && ok "node $(node -v)" || warn "node $(node -v) is old; Node 22+ is recommended"
command -v ffmpeg >/dev/null && ok "ffmpeg" || { echo "ffmpeg is missing. Install it (macOS: brew install ffmpeg, Debian/Ubuntu: sudo apt install ffmpeg) and re-run."; exit 1; }
# a working python 3 (python3 first; some systems only have python)
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "Python 3.9+ is missing. Install it (macOS: brew install python) and re-run."; exit 1; }
ok "$PY $($PY -c 'import sys;print(sys.version.split()[0])')"

say "2/4  Installing the skill → $DEST"
mkdir -p "$BASE/skills"
if [ -d "$DEST" ]; then
  BK="$BASE/skills-backup/motion-reel-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BASE/skills-backup"; mv "$DEST" "$BK"; ok "previous install moved to $BK"
fi
cp -R "$KIT/.claude/skills/motion-reel" "$DEST"
cp -R "$KIT/presets" "$DEST/presets"
cp "$KIT/package.json" "$DEST/package.json"
ok "skill, engine, scripts, templates and presets copied"

say "3/4  Installing Playwright + Chromium (for rendering)"
(cd "$DEST" && npm install --silent --no-audit --no-fund >/dev/null && npx --yes playwright install chromium >/dev/null) \
  && ok "playwright + chromium installed" || { echo "npm install failed in $DEST"; exit 1; }
if (cd "$DEST" && node -e "require('playwright').chromium.launch().then(b => b.close())" >/dev/null 2>&1); then
  ok "chromium launches"
else
  warn "chromium is installed but does not launch."
  [ "$(uname -s)" = "Linux" ] && echo "    On Linux it needs system libraries. Run:  sudo npx playwright install-deps chromium   (inside $DEST), then re-run this installer."
  [ "$(uname -s)" = "Linux" ] || echo "    Re-run this installer, or run: npx playwright install chromium (inside $DEST)."
fi

say "4/4  Installing Python audio libraries (numpy, scipy, soundfile, librosa, pillow)"
if "$PY" -c "import numpy, scipy, soundfile, librosa, PIL" 2>/dev/null; then
  ok "already installed"
elif "$PY" -m pip install --user -q -r "$KIT/requirements.txt" 2>/dev/null || "$PY" -m pip install -q -r "$KIT/requirements.txt" 2>/dev/null; then
  ok "installed"
else
  warn "pip refused to install them (common with Homebrew Python). Music, beat grid and mix need them."
  echo "    Fix: see 'Troubleshooting' in $KIT/README.md, then re-run this installer."
fi

say "Done."
echo "  Start a NEW Claude Code session (skills load when a session starts), open any project, and type:"
echo
echo "    /motion-reel a 15-second launch reel for https://yoursite.com"
echo
[ "$1" = "--project" ] || echo "  Tip: copy CLAUDE.md from this kit into a project root to make the motion rules apply to everything there."
