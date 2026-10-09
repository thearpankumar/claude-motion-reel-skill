# Motion Reel Kit: one entry point for every OS. It detects Windows vs macOS/Linux and runs the matching installer.
#
#   make install                      install /motion-reel for your user (every Claude Code project)
#   make install PROJECT=path/to/dir  install into one project only
#   make test                         scaffold + render a 5-second smoke test (videos/_test-<time>/renders)
#   make uninstall                    remove the user-level install
#   make help
#
# Windows needs GNU make (winget install ezwinports.make, or scoop/choco install make). Without it, run
#   powershell -ExecutionPolicy Bypass -File install\install.ps1

ifeq ($(OS),Windows_NT)
  PLATFORM := windows
  INSTALL  := powershell -NoProfile -ExecutionPolicy Bypass -File install/install.ps1
  PROJARG  := -Project
else
  PLATFORM := $(if $(filter Darwin,$(shell uname -s)),macos,linux)
  INSTALL  := sh install/install.sh
  PROJARG  := --project
endif

CLAUDE_HOME ?= $(if $(CLAUDE_CONFIG_DIR),$(CLAUDE_CONFIG_DIR),$(HOME)/.claude)

.PHONY: help install test uninstall

help:
	@echo "Motion Reel Kit ($(PLATFORM))"
	@echo "  make install [PROJECT=dir]   install the /motion-reel skill (user-level, or into one project)"
	@echo "  make test                    5-second smoke render"
	@echo "  make uninstall               remove the user-level install"

install:
	@echo "Detected OS: $(PLATFORM)"
	$(INSTALL) $(if $(PROJECT),$(PROJARG) "$(PROJECT)")

test:
	node install/test-render.mjs

uninstall:
	node -e "const p=require('path').join(process.env.CLAUDE_CONFIG_DIR||require('os').homedir()+'/.claude','skills','motion-reel');require('fs').rmSync(p,{recursive:true,force:true});console.log('removed',p)"
