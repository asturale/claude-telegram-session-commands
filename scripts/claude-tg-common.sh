# Sourced by the claude-tg-* bash scripts, not run directly.
# Settings can be overridden in ~/.config/claude-tg.env, which is also where a
# long-lived token goes (see README.md in this directory).

# Directory of the real scripts, also when they are symlinked into ~/.local/bin.
CLAUDE_TG_BIN=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
export PATH="$CLAUDE_TG_BIN:$HOME/.local/bin:$HOME/.bun/bin:$PATH"

# Started from inside a Claude session (a Bash tool call), these would make the
# new session think it is a child session, which turns off transcript saving.
unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_PID \
      AI_AGENT CLAUDE_EFFORT CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH

# Background sessions inherit the environment of the daemon that `claude --bg`
# starts on demand, so every script that may start it loads the token.
if [ -f "$HOME/.config/claude-tg.env" ]; then set -a; . "$HOME/.config/claude-tg.env"; set +a; fi

: "${CLAUDE_TG_CWD:=$HOME}"                    # where sessions start
: "${CLAUDE_TG_MODEL:=opus}"                   # model for a fresh session
: "${CLAUDE_TG_PERMISSION_MODE:=auto}"         # permission mode for a fresh session
: "${CLAUDE_TG_BTW_MODEL:=$CLAUDE_TG_MODEL}"   # model for /btw side tasks
: "${CLAUDE_TG_REMEMBER_MODEL:=sonnet}"        # model for /remember

CHANNEL="plugin:telegram@claude-plugins-official"
TG_DIR="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}"
CLAUDE_TG_STATE="$HOME/.local/state/claude-tg"
CLAUDE_TG_QUIT="$CLAUDE_TG_STATE/quit"         # stops claude-tg-loop.sh
mkdir -p "$CLAUDE_TG_STATE/sessions"
