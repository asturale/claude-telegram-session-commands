#!/usr/bin/env bash
# Respawn wrapper for a foreground Claude Code session with the Telegram channel,
# meant to run inside screen or tmux (see claude-tg-boot.sh).
# - When claude exits, the loop starts it again with --continue (conversation
#   kept, MCP servers and settings reloaded).
# - The first start is fresh, unless CLAUDE_TG_RESUME=1.
# - To stop for good, create ~/.local/state/claude-tg/quit and exit claude.
. "$(dirname "$(readlink -f "$0")")/claude-tg-common.sh"
cd "$CLAUDE_TG_CWD" || exit 1
# Mouse tracking leaks escape codes as text in some terminals behind screen.
export CLAUDE_CODE_DISABLE_MOUSE=1
# A stored interactive login (~/.claude/.credentials.json) takes precedence over
# CLAUDE_CODE_OAUTH_TOKEN. When its refresh fails, the session asks for /login
# although the token is valid. Move it aside so the token is used. Long-lived
# tokens are inference-only: Remote Control and claude.ai connectors stop working.
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -f "$HOME/.claude/.credentials.json" ]; then
  mv -f "$HOME/.claude/.credentials.json" "$HOME/.claude/.credentials.json.superseded"
fi
claude-tg-patch-plugin || true
rm -f "$CLAUDE_TG_QUIT"
if [ "${CLAUDE_TG_RESUME:-0}" = "1" ]; then CONT="--continue"; else CONT=""; fi
while true; do
  # --channels is variadic: keep it before the other options.
  claude --channels "$CHANNEL" $CONT --model "$CLAUDE_TG_MODEL" \
    --permission-mode "$CLAUDE_TG_PERMISSION_MODE"
  code=$?
  if [ -f "$CLAUDE_TG_QUIT" ]; then
    rm -f "$CLAUDE_TG_QUIT"
    echo "[claude-tg] quit flag found, stopping (exit $code)."
    break
  fi
  CONT="--continue"
  echo "[claude-tg] claude exited ($code), restarting in 2 s (Ctrl-C to stop)..."
  sleep 2
done
