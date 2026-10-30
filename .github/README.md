# Telegram session commands for Claude Code

A fork of the official [Telegram channel plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)
for Claude Code. It adds bot commands that manage the Claude Code session
itself from your phone: start a fresh session, interrupt or reload it, run and
manage side tasks, switch model, permission mode or effort, go back to an
earlier conversation, compact, save notes to memory, check usage and follow
progress live.

Everything else is the upstream plugin, unchanged. A daily GitHub Action merges
new upstream changes into this repository (see [Staying in sync](#staying-in-sync)).
The upstream documentation is in [README.md](../README.md) and [ACCESS.md](../ACCESS.md).

## Commands

| Command | What it does | Configured by |
| --- | --- | --- |
| `/clear [prompt]` | Start a fresh session, optionally with a first prompt | `TELEGRAM_CLEAR_CMD` |
| `/stop` | Interrupt the current turn (like Esc) | `TELEGRAM_STOP_CMD` |
| `/reload` | Restart the session, same conversation (reloads MCP servers and settings) | `TELEGRAM_RELOAD_CMD` |
| `/resume` | Buttons with recent conversations; tap one to continue it | `TELEGRAM_RESUME_CMD` |
| `/model` | Pick a model from inline buttons; the conversation continues on it | `TELEGRAM_MODEL_CMD`, `TELEGRAM_MODELS` |
| `/mode` | Pick a permission mode from inline buttons | `TELEGRAM_MODE_CMD`, `TELEGRAM_MODES` |
| `/effort` | Pick an effort level from inline buttons | `TELEGRAM_EFFORT_CMD`, `TELEGRAM_EFFORTS` |
| `/compact [instructions]` | Compact the conversation | `TELEGRAM_COMPACT_CMD` |
| `/btw <task>` | Run a side task in a separate session that reports back | `TELEGRAM_BTW_CMD` |
| `/tasks` | List side tasks; tap for the latest result, or stop one | `TELEGRAM_TASKS_CMD` |
| `/skill` | Buttons with your skills; tap one, or send `/skill <name> [text]`, to run it in the session | `TELEGRAM_SKILL_CMD` |
| `TELEGRAM_SKILL_CMD` | `<cmd> list` as above; `<cmd> <name>` on tap, `/skill <name> [text]` runs `<cmd> <name> [text]` |
| `/remember <text>` | Save a note to Claude's memory | `TELEGRAM_REMEMBER_CMD` |
| `/usage` | Plan limits and token usage | `TELEGRAM_USAGE_CMD` |
| `/status` | Pairing status, plus the output of your status script | `TELEGRAM_STATUS_CMD` |
| `/progress` | One message that updates live while the session works, with a stop button | `TELEGRAM_PROGRESS_CMD` |

The bot answers these commands itself instead of forwarding them to Claude.
That means they work while the session is busy, or stuck waiting on a
permission prompt. Only allowlisted senders can use them. A command whose
variable is unset stays hidden from the bot menu and `/help`.

## Voice messages and answer buttons

With `TELEGRAM_TRANSCRIBE_CMD` set, the plugin transcribes a voice message
itself and shows the transcript back with **Send** and **Discard** buttons.
Only Send passes it on to Claude, as if you had typed it. So a misheard word
("on" heard as "off") never turns into an action. Discard passes on nothing.
If the command fails or prints nothing, the voice message is passed on as it
was, as an attachment. Other messages are not held up while a transcription
runs.

`scripts/claude-tg-transcribe` does this with a local
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) build. If whisper
detects a language that is not in `CLAUDE_TG_TRANSCRIBE_LANGS` (for example
`nl,en`), it transcribes the message again in the first listed language.
After that, a small model (`CLAUDE_TG_TRANSCRIBE_FIX_MODEL`, default `haiku`,
empty to turn it off) fixes obvious recognition errors.

The `reply` tool also takes `buttons`, for example `["Yes", "No"]`. They appear
under the message. A tap reaches Claude as a message whose text is the label,
with `button_reply` in its meta. The buttons are then replaced by the choice.

In `manual` mode, permission prompts already reach Telegram as Allow/Deny
buttons (upstream behaviour). So `/mode` → manual is a practical way to step
through something that auto mode refuses, then switch back.

## How it works

The plugin does not hard-code how sessions are started or stopped. Each command
runs an executable that you point to in `~/.claude/channels/telegram/.env`:

```sh
# Actions (spawned detached)
TELEGRAM_CLEAR_CMD=/path/to/clear-script
TELEGRAM_STOP_CMD=/path/to/stop-script
TELEGRAM_RELOAD_CMD=/path/to/reload-script
TELEGRAM_COMPACT_CMD=/path/to/compact-script
TELEGRAM_BTW_CMD=/path/to/btw-script
TELEGRAM_REMEMBER_CMD=/path/to/remember-script
# Reports (stdout is the reply)
TELEGRAM_USAGE_CMD=/path/to/usage-script
TELEGRAM_STATUS_CMD=/path/to/status-script
# Switchers (inline buttons, then `<cmd> <value>`)
TELEGRAM_MODEL_CMD=/path/to/model-script
TELEGRAM_MODELS=Opus=opus,Sonnet=sonnet,Haiku=haiku
TELEGRAM_MODE_CMD=/path/to/mode-script
TELEGRAM_MODES=Auto=auto,Accept edits=acceptEdits,Manual=manual
TELEGRAM_EFFORT_CMD=/path/to/effort-script
TELEGRAM_EFFORTS=low,medium,high,xhigh,max
# Pickers (`<cmd> list` gives the buttons)
TELEGRAM_RESUME_CMD=/path/to/resume-script
TELEGRAM_TASKS_CMD=/path/to/tasks-script
# Live progress
TELEGRAM_PROGRESS_CMD=/path/to/progress-script
TELEGRAM_PROGRESS_INTERVAL=5        # seconds between updates
TELEGRAM_PROGRESS_MAX_MINUTES=15    # stop following after this
# Voice messages
TELEGRAM_TRANSCRIBE_CMD=/path/to/transcribe-script
TELEGRAM_TRANSCRIBE_TIMEOUT=300     # seconds
```

| Variable | Invoked as |
| --- | --- |
| `TELEGRAM_CLEAR_CMD` | `<cmd> [prompt]` |
| `TELEGRAM_STOP_CMD`, `TELEGRAM_RELOAD_CMD` | `<cmd>` |
| `TELEGRAM_COMPACT_CMD` | `<cmd> [instructions]` |
| `TELEGRAM_BTW_CMD` | `<cmd> <task>` |
| `TELEGRAM_REMEMBER_CMD` | `<cmd> <text>` |
| `TELEGRAM_USAGE_CMD` | `<cmd>`; stdout is the reply (30 s timeout) |
| `TELEGRAM_STATUS_CMD` | `<cmd>`; stdout is appended to `/status` (30 s timeout) |
| `TELEGRAM_MODEL_CMD`, `TELEGRAM_MODE_CMD`, `TELEGRAM_EFFORT_CMD` | `<cmd> <value>` |
| `TELEGRAM_RESUME_CMD` | `<cmd> list` prints `value<TAB>label` lines; `<cmd> <value>` on tap. A line with value `page-<n>` becomes a paging button: tapping it runs `<cmd> list <n>` and replaces the buttons |
| `TELEGRAM_TASKS_CMD` | `<cmd> list` as above; `<cmd> result <value>` or `<cmd> stop <value>` on tap, stdout is the reply |
| `TELEGRAM_PROGRESS_CMD` | `<cmd>`, repeatedly; stdout is the message, exit 0 = still busy, anything else = done |
| `TELEGRAM_TRANSCRIBE_CMD` | `<cmd> <audio file>`; stdout is the transcript |

`TELEGRAM_MODELS`, `TELEGRAM_MODES` and `TELEGRAM_EFFORTS` are `label=value`
lists separated by commas. Picker values must match `[A-Za-z0-9_.-]{1,40}`,
so they fit in Telegram's callback data.

Actions, switchers and `/resume` are spawned detached, because most of them
replace the session that owns the bot process.

### Writing the scripts

[`scripts/`](../scripts) has a complete set: it runs Claude Code in the
background on a Linux machine, starts it at boot, and implements every command
above. See [`scripts/README.md`](../scripts/README.md) to install it. To write
your own, some notes from building that set:

- **Replacing the session** (`/clear`, `/model`, `/mode`): start the new session
  first, for example
  `claude --bg --channels plugin:telegram@claude-plugins-official --model <m> --permission-mode <p> [--resume <session-id> --fork-session] "<prompt>"`.
  Then wait until `bot.pid` in the state directory changes (the new poller has
  taken over), and only then stop the old session with `claude stop <id>`.
  If the new session fails to start, the old one keeps running.
- **Authentication**: background sessions run under a supervisor daemon that
  `claude --bg` starts on demand, and they inherit that daemon's environment,
  not the environment of the script that asked for them. The daemon exits when
  its last session closes, so the next `claude --bg` starts a fresh one from
  whichever script happens to run it. If you sign in with a long-lived token
  (`claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`), set it in every script
  that runs `claude --bg`. Otherwise new sessions answer
  `Not logged in · Please run /login`.
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
- **Progress**: the session transcript (`~/.claude/projects/<project>/<session-id>.jsonl`)
  has everything you need. Take the last real user message, the `tool_use`
  entries after it, and the latest assistant text. Read only the end of
  the file, because the script runs every few seconds.
- **Typing into a session** (`/compact`, `/stop`): background sessions have no
  CLI input. A script can run `claude attach <id>` in a pseudo-terminal,
  wait for the UI, send `/compact` + Enter (or a bare Esc to interrupt), and
  close the attach client. The session keeps running.
- **Effort**: restart with `--effort <level>` rather than typing `/effort`.
  Typing it also saves the level as the default for new sessions.
- **Usage**: the CLI's own `/usage` reads `api.anthropic.com/api/oauth/usage`.
  That endpoint rate-limits hard, so cache the answer and respect
  `retry-after`. Token totals per model can also be added up from the
  `usage` fields in the transcripts.

## Multiple sessions

Telegram lets only one process poll a bot token, so normally one Claude Code
session at a time can be reached from Telegram. With `TELEGRAM_RELAY=1` in the
`.env`, several sessions share the bot. [`relay.ts`](../relay.ts) is then the
only process that polls. Each session's server connects to it over a unix
socket in the state directory and starts it if it isn't running. The relay
hands each update to one session. Sending is unchanged: every session calls the
Bot API itself.

| Command | What it does | Configured by |
| --- | --- | --- |
| `/sessions` | Open sessions as buttons: tap one to switch to it, ✕ to close it | `TELEGRAM_SESSION_INFO_CMD` (optional) |
| `/new [prompt]` | Pick a model, then open an extra session next to the others | `TELEGRAM_NEW_CMD`, `TELEGRAM_MODELS` |
| `/close` | Close the active session, after a confirmation | `TELEGRAM_CLOSE_CMD` |
| `/name [name]` | Name the active session, so its label reads `2·mail` instead of `2·sonnet`; no name goes back to the model | — |

- Plain messages go to the active session. A swipe-reply goes to the session
  that sent the message you reply to, and makes that session active. A button
  tap goes to the session that sent the button.
- With two or more sessions open, every message from a session starts with its
  label, for example `[2·sonnet]`. A message from a session that isn't active
  gets a "↩ Reply to 2·sonnet" button that makes it active.
- Permission replies (`yes abcde`) go to all sessions. Only the one that asked
  knows the code.
- The other commands (`/stop`, `/model`, `/progress`, …) act on the active
  session. Their scripts get `TELEGRAM_SESSION_PID`, the server pid of that
  session. Use it instead of `bot.pid` to find the session. `bot.pid` holds the
  active session's server pid, so scripts that don't know about the relay act on
  the active session.
- To replace a session in place (`/clear`, `/model`, …), write
  `{"from": <TELEGRAM_SESSION_PID>}` to `relay-handover` in the state directory
  before you start the new session. If it connects within two minutes, it takes
  over the old session's number and becomes active. Waiting for `bot.pid` to
  change still works.
- `relay-state.json` in the state directory lists the open sessions with their
  labels, names and conversation ids. A script that sends to Telegram on its
  own can use it to add the same label.
- Names are stored per conversation id in `session-names.json` in the state
  directory, so a `/resume` picker can show them for closed conversations too.
  A session that replaces another one through `relay-handover` keeps its name.
- A script can switch the active session: connect to `relay.sock` and send
  `{"t": "use", "pid": <server pid>}` followed by a newline. The relay answers
  `{"ok": true}` or `{"ok": false}`. A `/resume` picker can use this to offer
  the open sessions next to closed ones.
- With `TELEGRAM_AUTO_NEW=1`, closing the last open session through `/close`
  or ✕ opens a fresh one: `TELEGRAM_NEW_CMD <model>` on
  `TELEGRAM_DEFAULT_MODEL`, or the first `TELEGRAM_MODELS` entry. This happens
  at most once a minute, and not when a session crashes or is stopped another
  way.

| Variable | Invoked as |
| --- | --- |
| `TELEGRAM_NEW_CMD` | `<cmd> <model> [prompt]`, with `TELEGRAM_SESSION_PID` set to the active session (to copy its settings), unset if none is open |
| `TELEGRAM_CLOSE_CMD` | `<cmd>`, with `TELEGRAM_SESSION_PID` set to the session to close |
| `TELEGRAM_SESSION_INFO_CMD` | `<cmd>`, per session; prints JSON with optional `model` and `status` (`busy`/`idle`), used for the labels and `/sessions` |

The relay's commands work with no session open. It logs to `relay.log` in the
state directory. A new `relay.ts` replaces the running relay when the first
session with that version connects. Without `TELEGRAM_RELAY=1`, nothing
changes.

## Installing

Install the official plugin as usual
(`claude plugin install telegram@claude-plugins-official`), then replace its
`server.ts` with the one from this repository and add `relay.ts` next to it.
The installed copy lives in
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
