# Scripts for running Claude Code from Telegram in the background

A working set of the scripts the session commands call (see the
[main README](../.github/README.md)). With these, Claude Code runs on a server
or an always-on machine with nobody at the keyboard, and you steer it from
Telegram: start fresh sessions, switch models, run side tasks and keep several
sessions open at once.

They need Linux (they read `/proc`), bash, python3, git, `patch`, and `screen`
for the boot script. Messages and prompts are in English; change them to your
liking.

## How it runs

- At boot, `claude-tg-boot.sh` starts `claude-tg-loop.sh` in a detached
  `screen` session. The loop runs Claude Code with the Telegram channel and
  restarts it when it exits.
- The first `/clear`, `/model`, `/new`, … replaces that session with a
  background session (`claude --bg`). From then on, sessions are managed by
  Claude Code's background daemon. `claude agents` lists them and
  `claude attach <id>` opens one in a terminal.
- Each session start reapplies this repository's patch to the installed plugin
  (`claude-tg-patch-plugin`), so a plugin update doesn't break the commands.

## Install

1. Install the official plugin and pair your Telegram account as usual
   (`/telegram:configure`, `/telegram:access`).
2. Clone this repository and link the scripts into your `PATH`:

   ```sh
   git clone https://github.com/asturale/claude-telegram-session-commands ~/claude-telegram-session-commands
   mkdir -p ~/.local/bin
   ln -s ~/claude-telegram-session-commands/scripts/{claude-tg-*,tg-send} ~/.local/bin/
   ```

   The scripts find the clone through the symlinks. `git pull` updates them.
3. Patch the plugin once: `claude-tg-patch-plugin`.
4. Add the lines from [`telegram.env.example`](telegram.env.example) to
   `~/.claude/channels/telegram/.env`, with your own home directory.
5. Optional: copy [`claude-tg.env.example`](claude-tg.env.example) to
   `~/.config/claude-tg.env` (`chmod 600`) and set a long-lived token, the
   working directory or the default model.
6. Start it at boot: `crontab -e` and add
   `@reboot $HOME/.local/bin/claude-tg-boot.sh >> $HOME/.local/state/claude-tg/boot.log 2>&1`.
   Start it now by running `claude-tg-boot.sh` once.

The first start of Claude Code in the working directory may ask whether you
trust the folder. Run `claude` there once by hand and accept, or the unattended
start waits for an answer nobody gives.

## Authentication

For a machine nobody logs in to, use a long-lived token: run
`claude setup-token` and put the result in `~/.config/claude-tg.env` as
`CLAUDE_CODE_OAUTH_TOKEN`. Every script that starts a session loads that file.

- Background sessions take their environment from Claude Code's background
  daemon, not from the script that started them. The daemon stops when its last
  session closes and starts again on the next `claude --bg`. That's why every
  script that may start it loads the token; otherwise new sessions answer
  `Not logged in · Please run /login`.
- A stored interactive login (`~/.claude/.credentials.json`) takes precedence
  over the token. `claude-tg-loop.sh` moves it aside to
  `.credentials.json.superseded` when a token is set.
- Long-lived tokens only cover inference: Remote Control and claude.ai
  connectors don't work with them. Local MCP servers do.

## Files

| Script | Called for | What it does |
| --- | --- | --- |
| `claude-tg-boot.sh` | `@reboot` | Waits for the network, starts the loop in `screen` |
| `claude-tg-loop.sh` | boot script | Foreground session that restarts itself with `--continue` |
| `claude-tg-session` | `/clear` `/model` `/mode` `/effort` `/reload` `/resume` `/new` `/close` | Starts the replacement, waits for its poller, then stops the old session |
| `claude-tg-clear`, `-model`, `-mode`, `-effort`, `-reload`, `-new`, `-close` | the commands above | One-line wrappers around `claude-tg-session` |
| `claude-tg-current` | most scripts | Finds the session a command is about, prints JSON |
| `claude-tg-session-info` | `/sessions` | Model and status per session for the relay |
| `claude-tg-pin` | relay, when sessions open or close | Pins every open session in `~/.claude/jobs/pins.json` and unpins the ones it pinned that are gone (after a 15 s grace period, so a session reconnecting after an update keeps its pin), so the daemon doesn't retire an idle session you haven't closed |
| `claude-tg-btw` | `/btw` | Side session without the plugin; reports through `tg-send` |
| `claude-tg-remember` | `/remember` | Short side session that saves a note in Claude's memory |
| `claude-tg-tasks` | `/tasks` | Lists, shows or stops the side sessions |
| `claude-tg-skill` | `/skill` | Lists the skills you can invoke; types `/<skill> [text]` into the session |
| `claude-tg-compact`, `claude-tg-stop` | `/compact`, `/stop` | Type `/compact` or Esc into the session |
| `claude-tg-type` | the two above | Types into a background session through `claude attach` in a pseudo-terminal |
| `claude-tg-progress` | `/progress` | Request, steps and latest text from the session transcript |
| `claude-tg-status` | `/status` | Model, mode, context size and side tasks |
| `claude-tg-usage` | `/usage` | Plan limits (cached) and today's token use |
| `claude-tg-resume` | `/resume` | Open sessions and recent conversations as buttons, labelled with a short topic summary; a tap switches to or forks one. "☁ claude.ai sessions" lists the claude.ai sessions that are not archived (cloud and Remote Control, also from other computers); a tap copies that conversation to `~/.local/state/claude-tg/cloud/` and continues it in a new session. Needs a full `claude auth login` (a `setup-token` token cannot read sessions) |
| `claude-tg-recap` | `/recap`, 📝 in `/sessions` | A few lines on where a session stands: topic, done, open or waiting for you (`claude-tg-resume recap`; model `CLAUDE_TG_RECAP_MODEL`, default the summaries' model) |
| `claude-tg-autoname` | relay | A one- or two-word name for a session once its topic is clear (`claude-tg-resume name`, same model as the summaries) |
| `claude-tg-transcribe` | voice messages | Transcript through whisper.cpp, retried in your language if whisper guessed another, then cleaned up by a small model |
| `claude-tg-patch-plugin` | every start | Applies `server.ts` and `relay.ts` from this repository to the installed plugin |
| `claude-tg-usage-guard` | `PreToolUse` hook, timer | Pauses sessions near your plan limits and resumes them after the reset (see below) |
| `claude-tg-force` | `/force` | Takes the session out of the usage guard and resumes it if it was paused |
| `tg-send` | side sessions, errors | Sends a message to you through the Bot API |
| `claude-tg-common.sh` | the bash scripts | Settings, `PATH` and the token |

State and logs are in `~/.local/state/claude-tg/`: `session.log` for session
changes, `btw.log` for side tasks.

## Usage guard

Optional. Sessions that run on their own can use up your whole 5-hour window
or week, and then you have nothing left when you need Claude for something
urgent. `claude-tg-usage-guard` keeps the end free:

- At 80% of the 5-hour window or 90% of the week (`CLAUDE_TG_GUARD_SESSION`,
  `CLAUDE_TG_GUARD_WEEK` in `~/.config/claude-tg.env`), every tool call is
  denied except Telegram replies, `ToolSearch` and the task tools. The session
  tells you where it stands and stops.
- You get a message, and a one-shot user timer (`systemd-run --user`, else a
  detached `sleep`) types a "continue" message into the session two minutes
  after the reset. If it is still over a cap then (the week), it waits for the
  next reset.
- `/force [text]` takes the session out of the guard for the rest of its life
  and, if it was paused, resumes it right away. Use it for the session you
  need now.

The limits come from the same endpoint as `/usage` (cached for 3 minutes in
the same file). If they can't be read, nothing is blocked. To turn it on, add
the hook to `~/.claude/settings.json`:

```json
"hooks": {
  "PreToolUse": [
    { "hooks": [{ "type": "command", "command": "/home/you/.local/bin/claude-tg-usage-guard", "timeout": 15 }] }
  ]
}
```

and `TELEGRAM_FORCE_CMD` to the plugin's `.env`. It applies to every Claude
Code session on the machine, also ones not started from Telegram. To turn it
off for a while: `touch ~/.local/state/claude-tg/usage-guard/off`.

The guard checks between tool calls, so a long turn can still go a few percent
past the cap. That's why the default is 80% and not 95%.

## Stopping

- One session: `/close` in Telegram, or `claude stop <id>`.
- The foreground loop: `touch ~/.local/state/claude-tg/quit`, then exit
  Claude (`screen -r claude-tg`, `/exit`).

## Things to know

- `auto` permission mode isn't available on every plan. Without it, side tasks
  stop at the first permission prompt. Set `CLAUDE_TG_PERMISSION_MODE` to
  `acceptEdits` if so.
- Don't edit `claude-tg-session` while it runs: bash reads scripts as it goes.
- After a restart through `/model`, `/reload` and so on, the new session sees
  the old conversation. The prompt tells it not to restart again; keep that if
  you change the prompts, or it can loop.
