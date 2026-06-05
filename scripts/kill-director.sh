#!/bin/sh
# Reliably stop every Director process in ONE invocation.
#
# Why the old one-shot pkill needed running 3x: the default signal is SIGTERM,
# which our before-quit handler intercepts (abortAllAgents + snapshot flush) and
# can stall on; meanwhile electron-vite, the Electron main, and its helper
# processes (GPU/renderer/utility) are separate PIDs. So a single SIGTERM left
# survivors. This loops with SIGKILL until the tree is actually gone.
#
# Scope: the pattern requires BOTH this repo's path AND "electron" in the
# command line, so it matches the dev server + Electron main + all helpers
# (the Electron framework lives in this repo's node_modules) WITHOUT ever
# touching other Electron apps or the Claude Code session.

PAT='openai-voice-hack-night-2026-05-27.*[Ee]lectron'

i=0
while [ "$i" -lt 8 ]; do
  if ! pgrep -f "$PAT" >/dev/null 2>&1; then
    break
  fi
  pkill -9 -f "$PAT"
  i=$((i + 1))
  sleep 0.3
done

# The native PTT listener (uiohook) runs in-process and dies with main; the
# Codex worktree subprocesses and any dogfood next-server are caught here too.
pkill -9 -f 'openai-voice-hack-night-2026-05-27.*electron-vite' 2>/dev/null

if pgrep -f "$PAT" >/dev/null 2>&1; then
  echo "[kill] some processes survived — inspect: pgrep -fl '$PAT'"
  exit 1
fi
echo "[kill] all Director processes stopped."
exit 0
