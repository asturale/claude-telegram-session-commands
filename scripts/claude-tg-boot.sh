#!/usr/bin/env bash
# Start claude-tg-loop.sh in a detached screen session called claude-tg.
# Meant for `@reboot` in your crontab: waits for the network first, and does
# nothing if the screen session is already running.
. "$(dirname "$(readlink -f "$0")")/claude-tg-common.sh"

if screen -ls 2>/dev/null | grep -q '[.]claude-tg'; then
  echo "[claude-tg-boot] screen session claude-tg is already running."
  exit 0
fi

# Wait up to ~3 minutes for the internet (claude needs the API).
for _ in $(seq 1 60); do
  ping -c1 -W2 1.1.1.1 >/dev/null 2>&1 && break
  sleep 3
done

# Fresh start: after a crash or power cut, don't repeat a half-finished turn.
exec screen -dmS claude-tg "$CLAUDE_TG_BIN/claude-tg-loop.sh"
