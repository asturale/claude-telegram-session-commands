# Telegram session commands for Claude Code

A fork of the official [Telegram channel plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)
for Claude Code. It adds bot commands that manage the Claude Code session
itself from your phone: start a fresh session, run a side task, switch model or
permission mode, compact the conversation and check status.

Everything else is the upstream plugin, unchanged. A daily GitHub Action merges
new upstream changes into this repository (see [Staying in sync](#staying-in-sync)).
The upstream documentation is in [README.md](../README.md) and [ACCESS.md](../ACCESS.md).

## Commands

| Command | What it does | Configured by |
| --- | --- | --- |
| `/clear [prompt]` | Start a fresh session, optionally with a first prompt | `TELEGRAM_CLEAR_CMD` |
| `/btw <task>` | Run a side task in a separate session that reports back | `TELEGRAM_BTW_CMD` |
| `/model` | Pick a model from inline buttons; the conversation continues on it | `TELEGRAM_MODEL_CMD`, `TELEGRAM_MODELS` |
| `/mode` | Pick a permission mode from inline buttons | `TELEGRAM_MODE_CMD`, `TELEGRAM_MODES` |
| `/compact [instructions]` | Compact the conversation | `TELEGRAM_COMPACT_CMD` |
| `/status` | Pairing status, plus the output of your status script | `TELEGRAM_STATUS_CMD` |

The bot answers these commands itself instead of forwarding them to Claude.
That means they work while the session is busy, or stuck waiting on a
permission prompt. Only allowlisted senders can use them. A command whose
variable is unset stays hidden from the bot menu and `/help`.

In `manual` mode, permission prompts already reach Telegram as Allow/Deny
buttons (upstream behaviour). So `/mode` → manual is a practical way to step
through something that auto mode refuses, then switch back.

## How it works

The plugin does not hard-code how sessions are started or stopped. Each command
runs an executable that you point to in `~/.claude/channels/telegram/.env`:

```sh
TELEGRAM_CLEAR_CMD=/path/to/clear-script
TELEGRAM_BTW_CMD=/path/to/btw-script
TELEGRAM_MODEL_CMD=/path/to/model-script
TELEGRAM_MODELS=Opus=opus,Sonnet=sonnet,Haiku=haiku
TELEGRAM_MODE_CMD=/path/to/mode-script
TELEGRAM_MODES=Auto=auto,Accept edits=acceptEdits,Manual=manual
TELEGRAM_COMPACT_CMD=/path/to/compact-script
TELEGRAM_STATUS_CMD=/path/to/status-script
```

| Variable | Invoked as |
| --- | --- |
| `TELEGRAM_CLEAR_CMD` | `<cmd> [prompt]` |
| `TELEGRAM_BTW_CMD` | `<cmd> <task>` |
| `TELEGRAM_MODEL_CMD` | `<cmd> <model>` |
| `TELEGRAM_MODE_CMD` | `<cmd> <permission-mode>` |
| `TELEGRAM_COMPACT_CMD` | `<cmd> [instructions]` |
| `TELEGRAM_STATUS_CMD` | `<cmd>`; stdout is appended to `/status` (30 s timeout) |

`TELEGRAM_MODELS` and `TELEGRAM_MODES` are `label=value` lists separated by
commas. The defaults are `opus,sonnet,haiku` and `auto,acceptEdits,manual`.

All commands except `/status` are spawned detached, because `/clear`, `/model`
and `/mode` usually replace the session that owns the bot process.

### Writing the scripts

Some notes from building a working set:

- **Replacing the session** (`/clear`, `/model`, `/mode`): start the new session
  first, for example
  `claude --bg --channels plugin:telegram@claude-plugins-official --model <m> --permission-mode <p> [--resume <session-id> --fork-session] "<prompt>"`.
  Then wait until `bot.pid` in the state directory changes (the new poller has
  taken over), and only then stop the old session with `claude stop <id>`.
  If the new session fails to start, the old one keeps running.
- **`--channels` is variadic**: put it before the other options. A prompt that
  comes right after it is parsed as a second channel, and the session exits
  before it starts.
- **Finding the current session**: walk up the parent processes from `bot.pid`
  until you reach a pid listed by `claude agents --json`. Do not rely on the
  command line, because background sessions claimed from a pre-started spare
  process show `claude bg-spare …` there instead of their options.
- **Side tasks** (`/btw`): only one process can poll a bot token, so start the side
  session with this plugin disabled
  (`--settings '{"enabledPlugins":{"telegram@claude-plugins-official":false}}'`)
  and have it report back through the Bot API's `sendMessage`.
- **Compacting**: background sessions have no CLI input. A script can run
  `claude attach <id>` in a pseudo-terminal, type `/compact` and Enter, and
  close the attach client. The session keeps running.

## Installing

Install the official plugin as usual
(`claude plugin install telegram@claude-plugins-official`), then replace its
`server.ts` with the one from this repository. The installed copy lives in
`~/.claude/plugins/cache/claude-plugins-official/telegram/<version>/`. A plugin
update overwrites it, so reapply it afterwards. One way is to apply
`git diff upstream main -- server.ts` from this repository as a patch on each
session start. The new code loads when the session restarts.

## Staying in sync

[`.github/workflows/sync-upstream.yml`](workflows/sync-upstream.yml) runs daily.
It does a `git subtree split` of `external_plugins/telegram` from
`anthropics/claude-plugins-official`, updates the `upstream` branch with the
result, and merges it into `main`. The split is deterministic, so the
upstream history here is the same commits every time. If a merge conflicts, the
workflow opens an issue instead of pushing.

## License

Apache-2.0, like the upstream plugin. See [LICENSE](../LICENSE).
