#!/usr/bin/env bun
/**
 * Multi-session relay for the Telegram channel.
 *
 * Telegram allows exactly one getUpdates consumer per bot token, so normally
 * only one Claude Code session can be reached from Telegram. With
 * TELEGRAM_RELAY=1 in the state-dir .env, server.ts stops polling itself and
 * connects to this relay over a unix socket instead, starting it when it isn't
 * running. The relay is the single poller and hands every update to one
 * connected session, which runs it through its own bot handlers as before.
 * Sending stays direct: every session calls the Bot API itself.
 *
 * Routing:
 *   - plain messages go to the active session;
 *   - a swipe-reply to a message goes to the session that sent it (and makes
 *     that session active), button taps go to the session that sent the button;
 *   - permission replies ("yes abcde") go to every session; only the one that
 *     asked knows the id.
 *
 * With two or more sessions connected, outgoing messages are tagged with the
 * session's label ("[2·sonnet] …"), and messages from a session that is not
 * active carry a "Reply" button that makes it active.
 *
 * Handled by the relay itself (owner-only, so they work with no session open):
 *   /sessions          list sessions; tap one to switch, ✕ to close it, 📈 to
 *                      run /progress in it without switching
 *   /new [#name] [prompt]  `TELEGRAM_NEW_CMD <model>` on TELEGRAM_DEFAULT_MODEL,
 *                      named `name` when it connects. The prompt (or a photo or
 *                      file captioned /new …) and everything sent after /new
 *                      until the session connects are handed to it then,
 *                      unless you switch sessions in between
 *                      (with TELEGRAM_NEW_MODEL_MENU=1: pick a model first)
 *   /close [n]         close the active session or session n (`TELEGRAM_CLOSE_CMD`)
 *   /switch [n]        switch to session n (no number: the list)
 *   /progress n, /stop n   handed to session n (without a number: the active one)
 *   /name [n] [name]   name the active session or session n (empty: back to the model name)
 *   /2 [text]          text (or a photo or file captioned /2 …) to session 2 only,
 *                      without switching (forwards, photos and files sent
 *                      right after it go there too); /2 alone switches to it
 *   /recap [n|all]     `TELEGRAM_RECAP_CMD <session id>` for the active session,
 *                      session n or all of them: a few lines on where it stands
 *   /login             run TELEGRAM_LOGIN_CMD (`claude auth login`) in a
 *                      pseudo-terminal: its sign-in link goes to the chat, the
 *                      code you send back (as a reply) is typed in
 * Sessions get a fixed coloured dot per number (TELEGRAM_SESSION_DOTS=0: none).
 * Names are kept per conversation in session-names.json, so scripts (such as a
 * /resume picker) can show them too, and carry over to a session's replacement.
 * With TELEGRAM_AUTO_NEW=1, closing the last session through /close or ✕ opens
 * a fresh one on TELEGRAM_DEFAULT_MODEL (default: the first TELEGRAM_MODELS
 * entry); at most once a minute, and never after a crash.
 * A session opened without a prompt is announced by the relay as soon as it
 * connects, so the session itself needn't spend a turn saying it's ready.
 * With TELEGRAM_AUTONAME_CMD, a session without a name is named after its
 * topic: a minute after a message, `<cmd> <session id>` prints a short name, or
 * nothing while the topic is unclear (then it tries again, up to three times).
 * Commands run with TELEGRAM_SESSION_PID set to the server.ts pid of the
 * session they concern (for /new: the active one, to copy settings from).
 * TELEGRAM_SESSION_INFO_CMD, run the same way, prints JSON with optional
 * "model" and "status" ("busy"/"idle") for labels and the session list.
 * TELEGRAM_PIN_CMD runs whenever the set of sessions changes, as
 * `--all <server.ts pid>…` (or `--none` when none is left): for pinning every
 * open session, so the daemon does not retire one while idle. A session that
 * goes away keeps its pin for a grace period, and the "closed" notice waits as
 * long: a session that reconnects in time (the daemon restarting after a
 * Claude Code update) is not reported.
 * Sessions spawn their own scripts with TELEGRAM_SESSION_PID set to their own
 * server.ts pid, so existing session commands act on the session that ran them.
 *
 * bot.pid holds the server.ts pid of the active session, as it does without
 * the relay. Before restarting a session in place (/clear, /model …), a script
 * can write that pid to relay-handover; the next session to connect within two
 * minutes then takes over its number instead of getting a new one.
 *
 * A script can also switch the active session: connect to relay.sock and send
 * {"t": "use", "pid": <server.ts pid>}; the relay answers {"ok": true|false}.
 */

import { Api, type Bot } from 'grammy'
import type { Update } from 'grammy/types'
import { createHash } from 'crypto'
import { execFile, spawn } from 'child_process'
import { readFileSync, writeFileSync, rmSync, openSync, readSync, closeSync, statSync } from 'fs'
import { createConnection, createServer, type Socket } from 'net'
import { homedir } from 'os'
import { join } from 'path'

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'telegram')
const SOCK = join(STATE_DIR, 'relay.sock')
const LOCK = join(STATE_DIR, 'relay.pid')
const LOG = join(STATE_DIR, 'relay.log')
const BOT_PID = join(STATE_DIR, 'bot.pid')
const HANDOVER = join(STATE_DIR, 'relay-handover')
const STATE_FILE = join(STATE_DIR, 'relay-state.json')
const NAMES_FILE = join(STATE_DIR, 'session-names.json')
const HANDOVER_MS = 120_000
const RESTART_FILE = join(STATE_DIR, 'relay-restart.json')
const RESTART_MS = 30_000
const RELAY_PATH = import.meta.path
const diskVersion = () => {
  try {
    return createHash('sha256').update(readFileSync(RELAY_PATH)).digest('hex').slice(0, 12)
  } catch {
    return ''
  }
}
const VERSION = diskVersion()

type Msg = Record<string, any>

function writeLine(sock: Socket, msg: Msg): void {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n')
}

// Newline-delimited JSON in both directions.
function onLines(sock: Socket, handle: (msg: Msg) => void): void {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (data: string) => {
    buf += data
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        handle(JSON.parse(line))
      } catch (err) {
        process.stderr.write(`telegram relay: bad line: ${err}\n`)
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Client side: runs inside server.ts.

type MenuItem = { command: string; description: string; help: string }

// Bot menu: daily use, managing the session, settings, information, rarely.
const MENU_ORDER = 'sessions,switch,new,progress,recap,stop,btw,' +
  'clear,resume,name,close,compact,reload,' +
  'model,effort,mode,accept,skill,mcp,' +
  'status,usage,tasks,remember,' +
  'login,help,start'

export function startRelayClient(o: {
  bot: Bot
  menu: MenuItem[]
  onReady: (username: string) => void
  isShuttingDown: () => boolean
}): void {
  const { bot } = o
  const log = (s: string) => process.stderr.write(`telegram channel: ${s}\n`)
  // Scripts spawned by this server act on this session.
  process.env.TELEGRAM_SESSION_PID = String(process.pid)
  o.menu.push(
    { command: 'sessions', description: 'Open sessions: switch or close', help: '/sessions — open sessions: switch or close' },
    { command: 'new', description: 'Open an extra session', help: '/new [prompt] — open an extra session' },
    { command: 'switch', description: 'Switch to another session', help: '/switch [n] — switch to session n (no number: the list)' },
    { command: 'close', description: 'Close the active session', help: '/close [n] — close the active session, or session n' },
    { command: 'name', description: 'Name the active session', help: '/name [name] — name the active session (empty: model name)' },
    ...(process.env.TELEGRAM_RECAP_CMD ? [{ command: 'recap', description: 'Where a session stands, in a few lines', help: '/recap [n|all] — where the active session (n, or all) stands, in a few lines' }] : []),
    ...(process.env.TELEGRAM_LOGIN_CMD ? [{ command: 'login', description: 'Sign Claude Code in again', help: '/login — sign Claude Code in again (link, then send the code back)' }] : []),
  )

  let state = { label: '', active: true, multi: false }
  let sock: Socket | null = null
  let lastSpawn = 0

  // Tag messages and report what we sent, so taps and swipe-replies on them
  // find their way back to this session.
  bot.api.config.use(async (prev, method, payload, signal) => {
    const p = payload as Msg
    // A message from a session that isn't active gets a "↩ Reply to <label>"
    // button, which also says where it comes from; the text stays clean, so it
    // can be copied as is. Only when the message has buttons of its own does
    // the label go in front of the text instead.
    if (state.multi && !state.active && (method === 'sendMessage' || method === 'editMessageText') && typeof p.text === 'string') {
      const tag = p.parse_mode === 'MarkdownV2'
        ? `\\[${state.label.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')}\\] `
        : `[${state.label}] `
      if (p.reply_markup && !p.text.startsWith(tag) && p.text.length + tag.length <= 4096) {
        payload = { ...payload, text: tag + p.text }
      }
      if (!p.reply_markup) {
        payload = { ...payload, reply_markup: { inline_keyboard: [[
          { text: `↩ Reply to ${state.label}`, callback_data: `relay:use:${process.pid}` },
        ]] } }
      }
    }
    const res = await prev(method, payload, signal)
    const r = res.ok ? (res.result as Msg) : null
    if (sock && r && typeof r === 'object' && r.message_id && r.chat) {
      writeLine(sock, { t: 'sent', chat: String(r.chat.id), id: r.message_id })
    }
    return res
  })

  const connect = () => {
    if (o.isShuttingDown()) return
    const s = createConnection(SOCK)
    s.on('connect', () => {
      sock = s
      writeLine(s, { t: 'hello', pid: process.pid, version: VERSION, sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? '' })
      log('connected to relay')
    })
    onLines(s, msg => {
      if (msg.t === 'update') {
        bot.handleUpdate(msg.update as Update).catch(err => log(`handler error: ${err}`))
      } else if (msg.t === 'state') {
        state = { label: msg.label, active: msg.active, multi: msg.multi }
      }
    })
    s.on('error', err => {
      const code = (err as NodeJS.ErrnoException).code
      if ((code === 'ENOENT' || code === 'ECONNREFUSED') && Date.now() - lastSpawn > 10_000) {
        lastSpawn = Date.now()
        spawnRelay()
      }
    })
    s.on('close', () => {
      if (sock === s) sock = null
      if (!o.isShuttingDown()) setTimeout(connect, 1500)
    })
  }

  void (async () => {
    for (let attempt = 1; !o.isShuttingDown(); attempt++) {
      try {
        await bot.init()
        break
      } catch (err) {
        log(`getMe failed: ${err}, retrying`)
        await new Promise(r => setTimeout(r, Math.min(1000 * attempt, 15000)))
      }
    }
    o.onReady(bot.botInfo.username)
    // Most used first (TELEGRAM_MENU_ORDER overrides); commands not listed
    // follow in their own order. A session command replaces a built-in one
    // of the same name (/status).
    const all = new Map<string, string>([
      ['start', 'Welcome and setup guide'],
      ['help', 'What this bot can do'],
      ['status', 'Check your pairing status'],
    ])
    for (const m of o.menu) all.set(m.command, m.description)
    const order = (process.env.TELEGRAM_MENU_ORDER ?? MENU_ORDER).split(',').map(s => s.trim().replace(/^\//, ''))
    const rank = (c: string) => (order.includes(c) ? order.indexOf(c) : order.length)
    const commands = [...all].map(([command, description]) => ({ command, description }))
      .sort((a, b) => rank(a.command) - rank(b.command)) // stable: unlisted keep their order
    void bot.api.setMyCommands(commands, { scope: { type: 'all_private_chats' } }).catch(() => {})
    connect()
  })()
}

function spawnRelay(): void {
  // Not a child of any one session: it outlives the session that started it.
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CLAUDE') && k !== 'TELEGRAM_SESSION_PID') env[k] = v
  }
  const fd = openSync(LOG, 'a')
  const child = spawn(process.execPath, [RELAY_PATH], { detached: true, stdio: ['ignore', fd, fd], env, cwd: STATE_DIR })
  child.unref()
}

// ---------------------------------------------------------------------------
// Relay side: `bun relay.ts`.

type Client = {
  sock: Socket
  pid: number
  slot: number
  sessionId: string
  name: string
  model: string
  status: string
  lastActive: number
  replaced: boolean
  closing: boolean
  nameTries: number
  nameTimer: ReturnType<typeof setTimeout> | null
}

async function runRelay(): Promise<void> {
  const log = (s: string) => process.stderr.write(`${new Date().toISOString()} ${s}\n`)
  const ENV_FILE = join(STATE_DIR, '.env')
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN
  if (!TOKEN) {
    log('TELEGRAM_BOT_TOKEN missing')
    process.exit(1)
  }
  const NEW_CMD = process.env.TELEGRAM_NEW_CMD
  const CLOSE_CMD = process.env.TELEGRAM_CLOSE_CMD
  const INFO_CMD = process.env.TELEGRAM_SESSION_INFO_CMD
  const PIN_CMD = process.env.TELEGRAM_PIN_CMD
  const PROGRESS = !!process.env.TELEGRAM_PROGRESS_CMD // handled by server.ts
  const RECAP_CMD = process.env.TELEGRAM_RECAP_CMD
  const LOGIN_CMD = process.env.TELEGRAM_LOGIN_CMD
  const REPLY_SWITCHES = process.env.TELEGRAM_REPLY_SWITCHES === '1'
  const LOGIN_MS = 10 * 60_000
  const AUTONAME_CMD = process.env.TELEGRAM_AUTONAME_CMD
  const AUTONAME_MS = 60_000 // after a message, wait this long before naming
  const AUTONAME_TRIES = 3
  let pinned = '' // pids last handed to PIN_CMD
  let pinTimer: ReturnType<typeof setTimeout> | null = null
  let pinning = Promise.resolve('')
  const GRACE_MS = 15_000 // a disconnected session may come back within this
  const gone = new Map<string, { timer: ReturnType<typeof setTimeout>, slot: number, wasActive: boolean }>() // by sessionId
  const MODELS = (process.env.TELEGRAM_MODELS ?? 'opus=opus,sonnet=sonnet,haiku=haiku')
    .split(',').map(e => e.trim()).filter(Boolean)
    .map(e => {
      const [label, value] = e.includes('=') ? e.split('=', 2) : [e, e]
      return { label: label.trim(), value: value.trim() }
    })
  const AUTO_NEW = process.env.TELEGRAM_AUTO_NEW === '1'
  const DEFAULT_MODEL = process.env.TELEGRAM_DEFAULT_MODEL ?? MODELS[0]?.value ?? ''
  const AUTO_NEW_MS = 60_000
  let lastAutoNew = 0
  const NEW_MODEL_MENU = process.env.TELEGRAM_NEW_MODEL_MENU === '1'
  const READY_MS = 180_000 // a /new session that connects within this is announced
  const BUNDLE_MAX_MS = 3000
  // Sessions /new is opening: named on connect, announced if they have nothing
  // to do, handed `updates` (the prompt, and all that was sent after /new while
  // the session was starting) once they're there.
  type Opening = { model: string, until: number, name?: string, announce: boolean, updates: Update[] }
  let expectReady: Opening[] = []
  // The session the last /new is opening: messages go there, not to the active
  // one, until it connects or the user switches.
  let opening: Opening | null = null

  // One relay at a time.
  try {
    writeFileSync(LOCK, String(process.pid), { flag: 'wx' })
  } catch {
    try {
      const other = parseInt(readFileSync(LOCK, 'utf8'), 10)
      process.kill(other, 0)
      if (readFileSync(`/proc/${other}/cmdline`, 'utf8').includes('relay.ts')) {
        log(`relay already running (pid ${other})`)
        process.exit(0)
      }
    } catch {}
    writeFileSync(LOCK, String(process.pid))
  }

  // Left by the previous relay when it exited (see shutdown).
  type Snapshot = {
    active: number | null
    sessions: { pid: number, slot: number, name: string, model: string }[]
    owners?: [string, number][]
  }
  let restart: Snapshot | null = null
  const restartUntil = Date.now() + RESTART_MS
  try {
    if (Date.now() - statSync(RESTART_FILE).mtimeMs < RESTART_MS) restart = JSON.parse(readFileSync(RESTART_FILE, 'utf8'))
  } catch {}
  rmSync(RESTART_FILE, { force: true })
  const restarting = () => !!restart && Date.now() < restartUntil
  const replacedPids = new Set<number>()
  // A slot still held for a session that hasn't reconnected yet.
  const reserved = (slot: number) =>
    restarting() && restart!.sessions.some(s => s.slot === slot && !byPid(s.pid))

  // TELEGRAM_API_ROOT: a stand-in Bot API, for testing.
  const api = new Api(TOKEN, process.env.TELEGRAM_API_ROOT ? { apiRoot: process.env.TELEGRAM_API_ROOT } : undefined)
  const clients: Client[] = []
  let active: Client | null = null
  let offset = 0
  let exiting = false
  const owners = new Map<string, number>(restart?.owners ?? []) // `${chat}:${message_id}` → client pid
  const pendingNew = new Map<string, { prompt: string, update?: Update }>() // `${chat}:${message_id}` →
  let waiting: Update[] = []
  let waitTimer: ReturnType<typeof setTimeout> | null = null

  // Allowlisted DM senders, as in server.ts (static mode not supported here).
  const owner = (id: number | undefined) => {
    if (id == null) return false
    try {
      const access = JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8'))
      if (access.dmPolicy === 'disabled') return false
      return (access.allowFrom ?? []).includes(String(id))
    } catch {
      return false
    }
  }
  const ownerChats = (): string[] => {
    try {
      return JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8')).allowFrom ?? []
    } catch {
      return []
    }
  }
  const byPid = (pid: number) => clients.find(c => c.pid === pid) ?? null
  // The session a message came from, by the label it starts with ("[🔵 2·opus] …"):
  // for messages the relay has no owner for (sent before it started, or by a
  // session that has since been replaced under the same number).
  const bySlotTag = (text: string | undefined) => {
    const t = /^\[(?:\S+ )?(\d+)(?:·[^\]]*)?\]/.exec(text ?? '')
    const of = t ? clients.filter(c => c.slot === Number(t[1])) : []
    return of.find(c => !c.replaced) ?? of[0] ?? null
  }
  const shortModel = (m: string) => m.replace(/\[.*\]$/, '').replace(/^claude-/, '').replace(/[-.\d]+$/, '')
  // A fixed colour per number, so sessions are recognisable at a glance.
  const DOTS = ['🟢', '🔵', '🟣', '🟠', '🟡', '🔴', '🟤', '⚪']
  const dot = (slot: number) => (process.env.TELEGRAM_SESSION_DOTS === '0' ? '' : `${DOTS[(slot - 1) % DOTS.length]} `)
  const label = (c: Client) =>
    dot(c.slot) + (c.name ? `${c.slot}·${c.name}` : c.model ? `${c.slot}·${shortModel(c.model)}` : `${c.slot}`)
  const loadNames = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(NAMES_FILE, 'utf8'))
    } catch {
      return {}
    }
  }
  const saveName = (c: Client) => {
    if (!c.sessionId) return
    const names = loadNames()
    if (c.name) names[c.sessionId] = c.name
    else delete names[c.sessionId]
    try {
      writeFileSync(NAMES_FILE, JSON.stringify(names, null, 1))
    } catch (e) {
      log(`saving names failed: ${e}`)
    }
  }
  const statusText = (c: Client) => (c.status === 'busy' ? 'busy' : c.status === 'idle' ? 'idle' : c.status)
  const notify = (text: string) => {
    for (const chat of ownerChats()) void api.sendMessage(chat, text).catch(e => log(`notify failed: ${e}`))
  }

  // relay-state.json mirrors this for scripts that send to Telegram directly.
  const pushState = () => {
    const multi = clients.length > 1
    for (const c of clients) writeLine(c.sock, { t: 'state', label: label(c), active: c === active, multi })
    try {
      writeFileSync(STATE_FILE, JSON.stringify({
        multi,
        active: active?.pid ?? null,
        sessions: clients.map(c => ({
          pid: c.pid, slot: c.slot, label: label(c), name: c.name, sessionId: c.sessionId, model: c.model, status: c.status,
        })),
      }))
    } catch {}
  }

  const setActive = (c: Client | null) => {
    active = c
    opening = null
    if (c) {
      c.lastActive = Date.now()
      try {
        writeFileSync(BOT_PID, String(c.pid))
      } catch {}
    }
    pushState()
  }

  // Pin every open session; after `delay` ms, so one that is only reconnecting keeps its pin.
  const syncPins = (delay = 0) => {
    if (!PIN_CMD) return
    if (pinTimer) clearTimeout(pinTimer)
    pinTimer = setTimeout(() => {
      pinTimer = null
      const pids = clients.map(c => String(c.pid)).sort()
      if (pids.join(' ') === pinned) return
      pinned = pids.join(' ')
      // One at a time, in order: each run unpins what the previous one pinned.
      pinning = pinning.then(() => runWith(PIN_CMD, pids.length ? ['--all', ...pids] : ['--none'], undefined, false))
    }, delay)
  }

  const runWith = (cmd: string, args: string[], pid: number | undefined, detached: boolean, timeout = 20000): Promise<string> => {
    const env = { ...process.env, ...(pid ? { TELEGRAM_SESSION_PID: String(pid) } : {}) }
    if (detached) {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env })
      child.on('error', err => log(`${cmd} failed: ${err}`))
      child.unref()
      return Promise.resolve('')
    }
    return new Promise(resolve => {
      execFile(cmd, args, { timeout, encoding: 'utf8', env }, (_err, stdout) => resolve(stdout ?? ''))
    })
  }

  const refresh = async (c: Client) => {
    if (!INFO_CMD) return
    try {
      const info = JSON.parse((await runWith(INFO_CMD, [], c.pid, false)) || '{}')
      const before = label(c)
      c.model = info.model || c.model
      c.status = info.status || c.status
      if (label(c) !== before) pushState()
    } catch {}
  }

  // Name a session after its topic, a while after a message: once the name
  // command answers, or after AUTONAME_TRIES tries. A name set with /name stays.
  const autoName = (c: Client) => {
    if (!AUTONAME_CMD || c.name || !c.sessionId || c.nameTimer || c.nameTries >= AUTONAME_TRIES) return
    c.nameTimer = setTimeout(async () => {
      c.nameTimer = null
      if (c.name || !clients.includes(c)) return
      c.nameTries++
      const out = await runWith(AUTONAME_CMD, [c.sessionId], c.pid, false, 60000)
      const name = (out.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
      if (!name || c.name || !clients.includes(c)) return
      const before = label(c)
      c.name = name
      saveName(c)
      pushState()
      log(`session ${before} named ${label(c)}`)
    }, AUTONAME_MS)
  }

  const deliver = (c: Client, u: Update) => {
    writeLine(c.sock, { t: 'update', update: u })
    if (u.message) autoName(c)
  }

  const flushWaiting = () => {
    if (!active) return
    for (const u of waiting) deliver(active, u)
    waiting = []
    if (waitTimer) clearTimeout(waitTimer)
    waitTimer = null
  }

  // What belongs with "/2 look at this": forwards, photos and files sent along
  // with it arrive as separate updates, the screenshots only after they've
  // uploaded. Those from the same chat within BUNDLE_MAX_MS of the command go
  // to `to`, not to the active session; any other message closes the window.
  let gather: { chat: number, since: number, to: (u: Update) => void } | null = null

  const takeForward = (u: Update): boolean => {
    const m = u.message
    if (!gather || !m || m.chat.id !== gather.chat || !owner(m.from?.id)) return false
    if (Date.now() - gather.since > BUNDLE_MAX_MS) return false
    // A forward, or a photo/file without a command of its own.
    if (!m.forward_origin && (m.text != null || (m.caption ?? '').startsWith('/'))) return false
    gather.to(u)
    return true
  }

  // ---- relay commands --------------------------------------------------

  const sessionsList = async (chat: string) => {
    if (clients.length === 0) {
      await api.sendMessage(chat, 'No sessions open. Start one with /new.').catch(() => {})
      return
    }
    await Promise.race([Promise.all(clients.map(refresh)), new Promise(r => setTimeout(r, 10000))])
    // The name gets a full-width row of its own, the actions a row below it:
    // squeezed next to three buttons, names were cut off after a few letters.
    const rows = [...clients].sort((a, b) => a.slot - b.slot).flatMap(c => [[
      {
        text: `${c === active ? '● ' : ''}${label(c)}${c.name && c.model ? ` (${shortModel(c.model)})` : ''}${c.status ? ` · ${statusText(c)}` : ''}`,
        callback_data: `relay:use:${c.pid}`,
      },
    ], [
      ...(PROGRESS ? [{ text: '📈', callback_data: `relay:progress:${c.pid}` }] : []),
      ...(RECAP_CMD ? [{ text: '📝', callback_data: `relay:recap:${c.pid}` }] : []),
      { text: '✕', callback_data: `relay:ask:${c.pid}` },
    ]])
    if (NEW_CMD) rows.push([{ text: '+ New session', callback_data: 'relay:newmenu' }])
    await api.sendMessage(chat, `Sessions (● = active). Tap to switch${PROGRESS ? ', 📈 to follow' : ''}${RECAP_CMD ? ', 📝 for a recap' : ''}, ✕ to close:`, {
      reply_markup: { inline_keyboard: rows },
    }).catch(e => log(`sessions failed: ${e}`))
  }

  const modelLabel = (value: string) => MODELS.find(x => x.value === value)?.label ?? value

  // `text` is what followed /new: an optional #name, then the prompt. With
  // `update` (the /new message itself), the session gets the prompt as a
  // message once it connects (a photo or file with the prompt as its caption),
  // followed by whatever was sent after /new in the meantime, so a text and the
  // screenshots that upload after it arrive together.
  const startNew = (model: string, text: string, update?: Update) => {
    const nm = /^#(\S+)\s*([\s\S]*)$/.exec(text.trim())
    const name = nm ? nm[1].slice(0, 24) : undefined
    const prompt = (nm ? nm[2] : text).trim()
    const updates: Update[] = []
    const m = update?.message
    if (m && m.text == null) {
      const msg: Record<string, unknown> = { ...m }
      if (prompt) msg.caption = prompt
      else delete msg.caption
      delete msg.caption_entities
      updates.push({ ...update, message: msg } as Update)
    } else if (m && prompt) {
      const msg: Record<string, unknown> = { ...m, text: prompt }
      delete msg.entities
      updates.push({ ...update, message: msg } as Update)
    }
    const entry: Opening = { model, until: Date.now() + READY_MS, name, announce: !prompt, updates }
    expectReady.push(entry)
    opening = entry
    // Never connected: say so, rather than hold the messages forever.
    setTimeout(() => {
      if (!expectReady.includes(entry)) return
      expectReady.splice(expectReady.indexOf(entry), 1)
      if (opening === entry) opening = null
      notify(`The new session did not start${entry.updates.length ? `; ${entry.updates.length} message(s) sent to it were not delivered` : ''}.`)
    }, READY_MS)
    void runWith(NEW_CMD!, [model], active?.pid, true)
  }

  const newMenu = async (chat: string, prompt: string, update?: Update) => {
    if (!NEW_CMD) {
      await api.sendMessage(chat, '/new is not configured (TELEGRAM_NEW_CMD).').catch(() => {})
      return
    }
    if (!NEW_MODEL_MENU && DEFAULT_MODEL) {
      // Before the await: what is sent right after /new must already find `opening`.
      startNew(DEFAULT_MODEL, prompt, update)
      await api.sendMessage(chat, `Opening a new session on ${modelLabel(DEFAULT_MODEL)}…`).catch(() => {})
      return
    }
    // shortcut: with the model menu, messages sent before the tap still go to the active session.
    const sent = await api.sendMessage(chat, 'Open a new session on:', {
      reply_markup: { inline_keyboard: [MODELS.map((m, i) => ({ text: m.label, callback_data: `relay:new:${i}` }))] },
    }).catch(() => null)
    if (sent && (prompt || update)) pendingNew.set(`${chat}:${sent.message_id}`, { prompt, update })
  }

  const askClose = async (chat: string, c: Client | null) => {
    if (!c) {
      await api.sendMessage(chat, 'No active session.').catch(() => {})
      return
    }
    await api.sendMessage(chat, `Close session ${label(c)}? The conversation is kept and can be resumed later.`, {
      reply_markup: { inline_keyboard: [[
        { text: 'Yes, close', callback_data: `relay:close:${c.pid}` },
        { text: 'No', callback_data: 'relay:cancel' },
      ]] },
    }).catch(() => {})
  }

  const nameSession = async (chat: string, c: Client | null, name: string) => {
    if (!c) {
      await api.sendMessage(chat, 'No active session.').catch(() => {})
      return
    }
    const before = label(c)
    c.name = name.replace(/\s+/g, ' ').slice(0, 24)
    saveName(c)
    pushState()
    await api.sendMessage(chat, c.name
      ? `Session ${before} is now called ${label(c)}.`
      : `Session ${before} is back to its model name: ${label(c)}.`).catch(() => {})
  }

  // /login: LOGIN_CMD (`claude auth login`) in a pseudo-terminal. Its sign-in
  // link goes to the chat; the code that comes back is typed in.
  let login: { proc: ReturnType<typeof spawn>, chat: string, prompt: number, timer: ReturnType<typeof setTimeout> } | null = null

  const startLogin = async (chat: string) => {
    if (!LOGIN_CMD) {
      await api.sendMessage(chat, '/login is not configured (TELEGRAM_LOGIN_CMD).').catch(() => {})
      return
    }
    if (login) login.proc.kill()
    const env = { ...process.env, TERM: 'dumb', BROWSER: 'true' }
    const proc = spawn('script', ['-qfec', LOGIN_CMD, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'], env })
    const me = { proc, chat, prompt: 0, timer: setTimeout(() => proc.kill(), LOGIN_MS) }
    login = me
    let out = ''
    let asked = false
    const onData = async (d: Buffer) => {
      // Drop terminal links (OSC 8, keeps the visible text) and other escapes.
      out += d.toString().replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
      const url = /https:\/\/\S+/.exec(out)?.[0]
      if (asked || !url || !/paste|code/i.test(out.slice(out.indexOf(url) + url.length))) return
      asked = true
      const sent = await api.sendMessage(chat, `Open this link, sign in, then send me the code you get (as a reply to this message):\n\n${url}`, {
        reply_markup: { force_reply: true, input_field_placeholder: 'Code' },
        link_preview_options: { is_disabled: true },
      }).catch(e => (log(`login link failed: ${e}`), null))
      if (sent) me.prompt = sent.message_id
    }
    proc.stdout!.on('data', onData)
    proc.stderr!.on('data', onData)
    proc.on('exit', code => {
      clearTimeout(me.timer)
      if (login === me) login = null
      // The last line, without the prompt the code was typed after.
      const last = (out.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '').replace(/^.*>\s*/, '')
      log(`login exited ${code}: ${last}`)
      void api.sendMessage(chat, code === 0
        ? 'Signed in. Sessions that asked for /login: /reload them.'
        : `Sign-in didn't finish (exit ${code ?? 'killed'}). ${last}`).catch(() => {})
    })
    log('login started')
  }

  // The code for a pending /login: a reply to the link, or any message that
  // looks like one (code#state).
  const handleLoginCode = (u: Update): boolean => {
    const m = u.message
    if (!login || !m?.text || m.chat.type !== 'private' || !owner(m.from?.id) || String(m.chat.id) !== login.chat) return false
    const code = m.text.trim()
    const isReply = !!login.prompt && m.reply_to_message?.message_id === login.prompt
    if (!isReply && !/^[\w-]{20,}#[\w-]+$/.test(code)) return false
    login.proc.stdin!.write(`${code}\r`)
    // The code is single-use, but needn't stay in the chat.
    void api.deleteMessage(login.chat, m.message_id).catch(() => {})
    void api.sendMessage(login.chat, 'Code entered, checking…').catch(() => {})
    return true
  }

  // /recap: RECAP_CMD <session id> prints a few lines on where a session
  // stands. Run here, so a busy session isn't disturbed and nothing switches.
  const recap = async (chat: string, c: Client) => {
    const sent = await api.sendMessage(chat, `⏳ Recap of ${label(c)}…`).catch(() => null)
    const out = c.sessionId ? (await runWith(RECAP_CMD!, [c.sessionId], c.pid, false, 120000)).trim() : ''
    const text = `📝 ${label(c)}\n${out || '(no recap: nothing to summarize yet, or it failed)'}`
    if (sent) await api.editMessageText(chat, sent.message_id, text).catch(() => {})
    else await api.sendMessage(chat, text).catch(() => {})
  }

  const recapCommand = async (chat: string, arg: string) => {
    if (!RECAP_CMD) {
      await api.sendMessage(chat, '/recap is not configured (TELEGRAM_RECAP_CMD).').catch(() => {})
      return
    }
    const sorted = [...clients].sort((a, b) => a.slot - b.slot)
    const targets = !arg ? (active ? [active] : [])
      : /^all$/i.test(arg) ? sorted
      : sorted.filter(c => c.slot === Number(arg.replace(/^#/, '')))
    if (targets.length === 0) {
      await api.sendMessage(chat, arg ? `No session ${arg}. See /sessions.` : 'No active session.').catch(() => {})
      return
    }
    await Promise.all(targets.map(c => recap(chat, c)))
  }

  // Hand a session a command of its own (/progress, /stop), without making it
  // the active session. `u` is the update it answers (message or button tap).
  const forward = (c: Client, u: Update, command: string) => {
    const q = u.callback_query
    const m = u.message
    writeLine(c.sock, { t: 'update', update: {
      update_id: u.update_id,
      message: {
        message_id: m?.message_id ?? q?.message?.message_id ?? 0, date: Math.floor(Date.now() / 1000),
        chat: m?.chat ?? q?.message?.chat ?? { id: q!.from.id, type: 'private' },
        from: m?.from ?? q!.from, text: command, entities: [{ type: 'bot_command', offset: 0, length: command.length }],
      },
    } })
  }

  // /2 text (or a photo or file with /2 at the start of its caption): to
  // session 2 only, without switching. /2 alone switches to session 2.
  const handleShortcut = async (u: Update): Promise<boolean> => {
    const m = u.message
    if (!m || m.chat.type !== 'private' || !owner(m.from?.id)) return false
    const isText = m.text != null
    const body = isText ? m.text! : m.caption ?? ''
    const sc = /^\/(\d+)(?:@\w+)?(?:\s+|$)/.exec(body)
    if (!sc) return false
    const chat = String(m.chat.id)
    const c = clients.find(x => x.slot === Number(sc[1]) && !x.replaced)
    if (!c) {
      await api.sendMessage(chat, `No session ${sc[1]}. See /sessions.`).catch(() => {})
      return true
    }
    const rest = body.slice(sc[0].length)
    if (isText && !rest.trim()) {
      setActive(c)
      await api.sendMessage(chat, `→ Now talking to ${label(c)}.`).catch(() => {})
      return true
    }
    // Hand it on without the /2, entities shifted to match.
    const cut = sc[0].length
    const shift = (es?: { offset: number, length: number, type: string }[]) =>
      es?.filter(e => e.offset >= cut).map(e => ({ ...e, offset: e.offset - cut }))
    const msg: Record<string, unknown> = { ...m }
    if (isText) {
      msg.text = rest
      msg.entities = shift(m.entities)
    } else {
      if (rest) msg.caption = rest
      else delete msg.caption
      msg.caption_entities = shift(m.caption_entities)
    }
    deliver(c, { ...u, message: msg } as Update)
    // Forwards and screenshots sent along with it go to the same session.
    gather = { chat: m.chat.id, since: Date.now(), to: f => {
      if (clients.includes(c)) deliver(c, f)
      else if (active) deliver(active, f)
    } }
    return true
  }

  const handleCommand = async (u: Update): Promise<boolean> => {
    const m = u.message
    if (!m || m.chat.type !== 'private' || !owner(m.from?.id)) return false
    // A photo or file captioned /new …: opens a session that gets it.
    const cn = m.text == null ? /^\/new(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(m.caption ?? '') : null
    if (cn) {
      await newMenu(String(m.chat.id), (cn[1] ?? '').trim(), u)
      return true
    }
    const cm = /^\/(sessions|new|close|name|login|recap|switch|progress|stop)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(m.text ?? '')
    if (!cm) return false
    const chat = String(m.chat.id)
    const arg = (cm[2] ?? '').trim()
    // A session number: /switch 2, /progress 2, /stop 2, /close 2.
    const num = /^#?(\d+)$/.exec(arg)
    const target = num ? clients.find(c => c.slot === Number(num[1]) && !c.replaced) ?? null : null
    const noSuch = () => api.sendMessage(chat, `No session ${num![1]}. See /sessions.`).catch(() => {})
    if (cm[1] === 'progress' || cm[1] === 'stop') {
      if (!num) return false // the active session handles it
      if (target) forward(target, u, `/${cm[1]}`)
      else await noSuch()
      return true
    }
    if (cm[1] === 'switch') {
      if (!num) await sessionsList(chat)
      else if (!target) await noSuch()
      else {
        setActive(target)
        await api.sendMessage(chat, `→ Now talking to ${label(target)}.`).catch(() => {})
      }
      return true
    }
    if (cm[1] === 'close' && num) {
      if (target) await askClose(chat, target)
      else await noSuch()
      return true
    }
    if (cm[1] === 'sessions') await sessionsList(chat)
    else if (cm[1] === 'recap') await recapCommand(chat, (cm[2] ?? '').trim())
    else if (cm[1] === 'login') await startLogin(chat)
    else if (cm[1] === 'new') await newMenu(chat, (cm[2] ?? '').trim(), u)
    else if (cm[1] === 'name') {
      // /name 6 mail: session 6 (/name 6 alone: back to its model name).
      const nm = /^#?(\d+)(?:\s+([\s\S]*))?$/.exec(arg)
      const c = nm ? clients.find(x => x.slot === Number(nm[1]) && !x.replaced) ?? null : active
      if (nm && !c) await api.sendMessage(chat, `No session ${nm[1]}. See /sessions.`).catch(() => {})
      else await nameSession(chat, c, nm ? (nm[2] ?? '').trim() : arg)
    }
    else await askClose(chat, active)
    return true
  }

  // Overrule an auto-mode denial (scripts/claude-tg-overrule). Everything lives
  // here, in memory: the hook only passes on what Claude Code gave it. The
  // message and the key are made from the same tool_input, so what the owner
  // sees is what gets allowed, and a session can't write itself a ticket.
  const overruleAsks = new Map<string, { key: string, tool: string, sessionId: string, at: number }>()
  const overruleTickets = new Map<string, number>() // key → expiry (ms)
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable)
      : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable((v as Record<string, unknown>)[k])]))
      : v
  // Same session, tool and input (minus the free-text description) = same call.
  // Bash's description is free text Claude rewrites on a retry; every other field counts.
  const overruleFields = (tool: string, input: Record<string, unknown>) => {
    if (tool !== 'Bash') return input
    const { description: _, ...rest } = input
    return rest
  }
  // For Bash: the contents of every existing file the command names (scripts, configs,
  // inputs) are part of the key, so a file changed after the tap no longer matches.
  // Catches what RUNS_A_FILE misses (env/nohup/timeout/make/npm run …).
  const fileHashes = (tool: string, input: Record<string, unknown>, cwd: string): string[] => {
    if (tool !== 'Bash' || typeof input.command !== 'string') return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of input.command.split(/[\s;&|()<>`=]+/)) {
      if (seen.size >= 20) break // bounded work per call
      const tok = raw.replace(/^['"]+|['"]+$/g, '')
      if (!tok || tok.startsWith('-')) continue
      const p = tok.startsWith('/') ? tok : tok.startsWith('~/') ? join(homedir(), tok.slice(2)) : cwd ? join(cwd, tok) : ''
      if (!p || seen.has(p) || /^\/(proc|sys|dev)(\/|$)/.test(p)) continue
      seen.add(p)
      try {
        const st = statSync(p)
        if (!st.isFile()) continue
        // Bounded read: at most 1 MB hashed, plus size and mtime for anything bigger.
        const buf = Buffer.alloc(Math.min(st.size, 1_000_000))
        const fd = openSync(p, 'r')
        try { readSync(fd, buf, 0, buf.length, 0) } finally { closeSync(fd) }
        out.push(`${p}:${st.size}:${st.size > buf.length ? st.mtimeMs : ''}:${createHash('sha256').update(buf).digest('hex')}`)
      } catch {}
    }
    return out.sort()
  }
  const overruleKey = (sessionId: string, tool: string, input: Record<string, unknown>, cwd = '') =>
    createHash('sha256').update(JSON.stringify([sessionId, tool, stable(overruleFields(tool, input)), fileHashes(tool, input, cwd)])).digest('hex')
  // Control, bidi and other invisible characters shown as \u{…}, so the text can't hide what runs.
  const visible = (t: string) => t.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ch => ch === '\n' ? ch : `\\u{${ch.codePointAt(0)!.toString(16)}}`)
  const overruleShow = (tool: string, input: Record<string, unknown>) => {
    const fields = overruleFields(tool, input)
    const { command, ...other } = fields
    return visible(tool === 'Bash' && typeof command === 'string'
      ? command + (Object.keys(other).length ? `\n\n${JSON.stringify(other)}` : '')
      : JSON.stringify(fields, null, 1))
  }
  // Calls an overrule can't safely cover: Claude Code still runs the classifier on
  // file-edit tools after a hook "allow" (so the button would only burn a ticket), and a
  // command that runs a file approves its name, not the contents Claude can still change.
  const NO_OVERRULE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
  // Fail closed: a command may run a file when any word is a path to one, starts at a
  // path, or is a program that runs scripts, packages or other commands.
  const RUNNER = /^(?:(?:ba|z|da|k|c|tc|fi)?sh|pwsh|python[\d.]*|node|bun|bunx|deno|perl|ruby|php|lua|awk|gawk|source|\.|exec|xargs|env|nohup|timeout|sudo|doas|make|npm|npx|pnpm|yarn|uv|uvx|pytest|cargo|go|tsx|ts-node|eval|watch|parallel|nice|ionice|stdbuf|setsid|chroot|busybox|command|builtin|time|strace|ltrace|flock|script|taskset|chrt|unbuffer|systemd-run|find|bwrap|firejail|flatpak|snap)$/
  const mayRunFile = (command: string, cwd: string) => {
    const words = command.split(/[\s;&|()<>`]+/).map(w => w.replace(/^['"]+|['"]+$/g, '')).filter(Boolean)
    if (/<|\|\s*(?:\S*\/)?(?:(?:ba|z|da)?sh|python[\d.]*|node|perl|ruby|bun)\b/.test(command)) return true
    if (words.some(w => RUNNER.test(w.replace(/^.*\//, '')) || w.startsWith('$'))) return true
    const first = words[0] ?? ''
    if (first.includes('/') || first.startsWith('~')) return true
    if (words.some(w => /\.(?:sh|py|js|mjs|cjs|ts|pl|rb|php|lua)$/.test(w))) return true
    // Any word with a slash that is an executable file, or can't be checked: fail closed.
    return words.slice(1).some(w => {
      if (!w.includes('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return false // URLs are fine
      const p = w.startsWith('/') ? w : w.startsWith('~/') ? join(homedir(), w.slice(2)) : cwd ? join(cwd, w) : ''
      if (!p) return true
      try { const st = statSync(p); return st.isFile() && (st.mode & 0o111) !== 0 } catch { return false }
    })
  }
  const noOverruleWhy = (tool: string, input: Record<string, unknown>, cwd: string): string | null => {
    if (NO_OVERRULE_TOOLS.has(tool)) return process.env.TELEGRAM_ACCEPT_CMD
      ? 'file edits can\'t be overruled with a button; send /accept (acceptEdits until the turn ends), then ask for the edit again'
      : 'file edits can\'t be overruled from here; approve in the terminal'
    if (tool === 'Bash' && typeof input.command === 'string' && mayRunFile(input.command, cwd))
      return 'it runs a file whose contents you can\'t see here; approve in the terminal'
    return null
  }
  const overruleAsk = async (msg: Msg) => {
    const sessionId = String(msg.session_id ?? '')
    const tool = String(msg.tool_name ?? '')
    const input = msg.tool_input
    const c = clients.find(x => x.sessionId === sessionId && sessionId && !x.replaced)
    const chat = ownerChats()[0]
    if (!c || !tool || !chat || !input || typeof input !== 'object' || Array.isArray(input)) return
    const now = Date.now()
    for (const [id, a] of overruleAsks) if (now - a.at > 30 * 60_000) overruleAsks.delete(id)
    const id = createHash('sha256').update(`${now}${Math.random()}`).digest('hex').slice(0, 12)
    const inp = input as Record<string, unknown>
    overruleAsks.set(id, { key: overruleKey(sessionId, tool, inp, String(msg.cwd ?? '')), tool, sessionId, at: now })
    // The reason comes from the hook, i.e. from the session's side: shown, but marked as such.
    const reason = visible(String(msg.reason ?? '?')).slice(0, 300)
    const body = overruleShow(tool, inp)
    const why = noOverruleWhy(tool, inp, String(msg.cwd ?? ''))
    if (why) {
      overruleAsks.delete(id)
      await api.sendMessage(chat, `[${label(c)}] 🛑 Auto mode denied ${tool}:\n\n${body.slice(0, 1500)}\n\nReason (as reported): ${reason}\n\nNo overrule: ${why}.`)
        .catch(err => log(`overrule message failed: ${err}`))
      return
    }
    if (body.length > 3000) {
      // Too long to review on a phone: no button rather than a cut-off approval.
      overruleAsks.delete(id)
      await api.sendMessage(chat, `[${label(c)}] 🛑 Auto mode denied ${tool} (${body.length} characters, too long to review here; no overrule).\n\nReason (as reported): ${reason}`)
        .catch(err => log(`overrule message failed: ${err}`))
      return
    }
    await api.sendMessage(chat, `[${label(c)}] 🛑 Auto mode denied ${tool}:\n\n${body}\n\nReason (as reported): ${reason}\n\nAllow this exact call once?`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ Do it anyway', callback_data: `ovr:yes:${id}` },
        { text: '❌ No', callback_data: `ovr:no:${id}` },
      ]] },
    }).catch(err => log(`overrule message failed: ${err}`))
  }
  // A PreToolUse check: true once for a ticketed call, then the ticket is gone.
  const overruleUse = (msg: Msg): boolean => {
    const input = msg.tool_input
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false
    if (overruleTickets.size === 0) return false // the common case: no work on every tool call
    const key = overruleKey(String(msg.session_id ?? ''), String(msg.tool_name ?? ''), input as Record<string, unknown>, String(msg.cwd ?? ''))
    const now = Date.now()
    for (const [k, t] of overruleTickets) if (t <= now) overruleTickets.delete(k)
    const until = overruleTickets.get(key)
    if (until == null) return false
    overruleTickets.delete(key)
    return until > Date.now()
  }
  const handleOverrule = async (u: Update): Promise<boolean> => {
    const q = u.callback_query
    const m = /^ovr:(yes|no):([0-9a-f]{12})$/.exec(q?.data ?? '')
    if (!q || !m) return false
    const answer = (text: string) => api.answerCallbackQuery(q.id, { text }).catch(() => {})
    if (!owner(q.from.id) || (q.message && q.message.chat.type !== 'private')) {
      await answer('Not authorized.')
      return true
    }
    const req = overruleAsks.get(m[2])
    overruleAsks.delete(m[2]) // one answer per request
    if (!req || Date.now() - req.at > 30 * 60_000) {
      await answer('Expired or already answered.')
      return true
    }
    const yes = m[1] === 'yes'
    if (yes) overruleTickets.set(req.key, Date.now() + 10 * 60_000)
    await answer(yes ? 'Allowed once' : 'Kept denied')
    const chat = String(q.message?.chat.id ?? q.from.id)
    if (q.message && 'text' in q.message && q.message.text) {
      const verdict = yes ? '→ ✅ Allowed once (10 min)' : '→ ❌ Kept denied'
      await api.editMessageText(chat, q.message.message_id, `${q.message.text}\n\n${verdict}`).catch(() => {})
    }
    const c = clients.find(x => x.sessionId === req.sessionId && !x.replaced)
    if (c) {
      const text = yes
        ? `[overrule] The owner allowed your auto-mode-denied ${req.tool} call once (valid 10 minutes). Run exactly the same call again now.`
        : `[overrule] The owner kept your auto-mode-denied ${req.tool} call denied. Do not retry it.`
      writeLine(c.sock, { t: 'update', update: {
        update_id: u.update_id,
        message: {
          message_id: q.message?.message_id ?? 0, date: Math.floor(Date.now() / 1000),
          chat: q.message?.chat ?? { id: q.from.id, type: 'private' }, from: q.from, text,
        },
      } })
    }
    return true
  }

  const handleCallback = async (u: Update): Promise<boolean> => {
    const q = u.callback_query
    if (!q?.data?.startsWith('relay:')) return false
    const answer = (text?: string) => api.answerCallbackQuery(q.id, text ? { text } : {}).catch(() => {})
    if (!owner(q.from.id) || (q.message && q.message.chat.type !== 'private')) {
      await answer('Not authorized.')
      return true
    }
    const chat = String(q.message?.chat.id ?? q.from.id)
    const msgId = q.message?.message_id
    const edit = (text: string) =>
      msgId ? api.editMessageText(chat, msgId, text).catch(() => {}) : Promise.resolve()
    const [, action, arg] = q.data.split(':')
    const c = arg ? byPid(Number(arg)) : null
    switch (action) {
      case 'use':
        if (!c) {
          await answer('That session is closed.')
          break
        }
        setActive(c)
        await answer(`Now talking to ${label(c)}`)
        if (msgId && q.message && !('text' in q.message && q.message.text?.startsWith('Sessions'))) {
          await api.editMessageReplyMarkup(chat, msgId).catch(() => {})
        }
        await api.sendMessage(chat, `→ Now talking to ${label(c)}.`).catch(() => {})
        break
      case 'ask':
        await answer()
        await askClose(chat, c)
        break
      case 'progress':
        if (!c) {
          await answer('That session is closed.')
          break
        }
        await answer(`Following ${label(c)}`)
        forward(c, u, '/progress')
        break
      case 'recap':
        if (!c || !RECAP_CMD) {
          await answer(c ? 'Not configured (TELEGRAM_RECAP_CMD).' : 'That session is closed.')
          break
        }
        await answer(`Recap of ${label(c)}`)
        void recap(chat, c)
        break
      case 'close':
        if (!c) {
          await answer('Already closed.')
          await edit('Session already closed.')
          break
        }
        if (!CLOSE_CMD) {
          await answer('Not configured (TELEGRAM_CLOSE_CMD).')
          break
        }
        c.closing = true
        await answer('Closing…')
        await edit(`Closing session ${label(c)}…`)
        void runWith(CLOSE_CMD, [], c.pid, true)
        break
      case 'cancel':
        await answer()
        await edit('Cancelled.')
        break
      case 'newmenu':
        await answer()
        await newMenu(chat, '')
        break
      case 'new': {
        const model = MODELS[Number(arg)]
        if (!model || !NEW_CMD) {
          await answer()
          break
        }
        const key = `${chat}:${msgId}`
        const pending = pendingNew.get(key)
        pendingNew.delete(key)
        await answer(`Starting ${model.label}…`)
        await edit(`Opening a new session on ${model.label}…`)
        startNew(model.value, pending?.prompt ?? '', pending?.update)
        break
      }
      default:
        await answer()
    }
    return true
  }

  // ---- routing ---------------------------------------------------------

  const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

  const route = async (u: Update) => {
    if (takeForward(u)) return
    // Anything else ends the window first, so the order stays as sent.
    gather = null
    if (await handleShortcut(u)) return
    if (await handleCommand(u)) return
    if (handleLoginCode(u)) return
    if (await handleOverrule(u)) return
    if (await handleCallback(u)) return

    const q = u.callback_query
    const m = u.message
    if (q?.message) {
      const pid = owners.get(`${q.message.chat.id}:${q.message.message_id}`)
      const tagged = bySlotTag('text' in q.message ? q.message.text : undefined)
      if (pid != null || tagged) {
        const c = (pid != null ? byPid(pid) : null) ?? tagged
        if (c) deliver(c, u)
        else await api.answerCallbackQuery(q.id, { text: 'That session is closed.' }).catch(() => {})
        return
      }
    }
    if (m?.text && PERMISSION_REPLY_RE.test(m.text)) {
      for (const c of clients) deliver(c, u)
      return
    }
    if (m?.reply_to_message) {
      const pid = owners.get(`${m.chat.id}:${m.reply_to_message.message_id}`)
      const r = m.reply_to_message
      const c = (pid != null ? byPid(pid) : null) ?? bySlotTag('text' in r ? r.text : r.caption)
      if (c) {
        // A reply is a side remark: the active session stays, unless configured otherwise.
        if (REPLY_SWITCHES && c !== active && m.chat.type === 'private' && owner(m.from?.id)) setActive(c)
        deliver(c, u)
        return
      }
    }
    // Everything sent after /new is for the session it opens, also while that starts.
    if (opening && m?.chat.type === 'private' && owner(m.from?.id)) {
      opening.updates.push(u)
      return
    }
    if (active) {
      deliver(active, u)
      return
    }
    // No session (yet): hold briefly, e.g. while a session reconnects.
    waiting.push(u)
    waitTimer ??= setTimeout(() => {
      waitTimer = null
      if (active || waiting.length === 0) return
      const chats = new Set(waiting.map(w => w.message?.chat.id).filter(id => id != null && owner(id)))
      waiting = []
      for (const chat of chats) {
        void api.sendMessage(chat!, 'No session open. Start one with /new.').catch(() => {})
      }
    }, 20000)
  }

  // ---- socket server ---------------------------------------------------

  const shutdown = async (why: string) => {
    if (exiting) return
    exiting = true
    log(`exiting: ${why}`)
    server.close()
    // Confirm what we already handled so the next relay doesn't get it again.
    await Promise.race([
      api.getUpdates({ offset, limit: 1, timeout: 0 }).catch(() => {}),
      new Promise(r => setTimeout(r, 3000)),
    ])
    for (const c of clients) c.sock.destroy()
    try {
      if (parseInt(readFileSync(LOCK, 'utf8'), 10) === process.pid) rmSync(LOCK)
    } catch {}
    rmSync(SOCK, { force: true })
    rmSync(STATE_FILE, { force: true })
    // For the next relay (sessions reconnect within seconds): same numbers,
    // names and active session.
    try {
      writeFileSync(RESTART_FILE, JSON.stringify({
        active: active?.pid ?? null,
        sessions: clients.map(c => ({ pid: c.pid, slot: c.slot, name: c.name, model: c.model })),
        owners: [...owners],
      }))
    } catch {}
    process.exit(0)
  }

  rmSync(SOCK, { force: true })
  const server = createServer(sock => {
    let client: Client | null = null
    onLines(sock, msg => {
      if (msg.t === 'ovr-ask' && !client) {
        // From the overrule hook: auto mode denied a call.
        void overruleAsk(msg)
        sock.end()
      } else if (msg.t === 'ovr-use' && !client) {
        writeLine(sock, { allow: overruleUse(msg) })
        sock.end()
      } else if (msg.t === 'use' && !client) {
        // From a script, not a session: switch the active session.
        const c = byPid(Number(msg.pid))
        if (c) {
          setActive(c)
          notify(`→ Now talking to ${label(c)}.`)
        }
        writeLine(sock, { ok: !!c })
        sock.end()
      } else if (msg.t === 'hello') {
        if (msg.version !== VERSION) {
          // Versions differ. Only make way if relay.ts on disk changed since
          // this relay started: the session respawns it from the new file.
          // If this relay already matches the disk, the session is the stale
          // one (it loaded relay.ts before an update) and would just respawn
          // this same version, so restarting would loop forever: keep it.
          if (diskVersion() !== VERSION) {
            void shutdown(`version ${msg.version} connected, mine is ${VERSION}`)
            return
          }
          log(`session pid ${msg.pid} runs older relay.ts ${msg.version}, keeping ${VERSION}`)
        }
        const pid = Number(msg.pid)
        const prev = restarting() ? restart!.sessions.find(s => s.pid === pid) : undefined
        const old = !!prev && replacedPids.has(pid) // already replaced, see `took`
        let slot = 0
        let inherited: Client | null = null
        let took: Snapshot['sessions'][number] | undefined // replaced before it reconnected
        try {
          // Left for the session that replaces `from`. After a relay restart
          // all sessions reconnect at once: those the previous relay knew
          // aren't the replacement, so leave it for the next one.
          const h = JSON.parse(readFileSync(HANDOVER, 'utf8'))
          const from = Number(h.from)
          const fresh = Date.now() - statSync(HANDOVER).mtimeMs < HANDOVER_MS
          if (fresh && !prev && from !== pid) {
            inherited = byPid(from)
            if (!inherited && restarting()) took = restart!.sessions.find(s => s.pid === from)
            if (took) replacedPids.add(from)
          }
          if (!fresh || inherited || took) rmSync(HANDOVER, { force: true })
        } catch {}
        if (inherited) {
          inherited.replaced = true
          slot = inherited.slot
        }
        if (took) slot = took.slot
        if (old) slot = prev!.slot
        const sessionId = String(msg.sessionId ?? '')
        const back = sessionId ? gone.get(sessionId) : undefined
        if (back) {
          // Back within the grace period: no "closed" notice, same number if free.
          clearTimeout(back.timer)
          gone.delete(sessionId)
          if (!inherited && !clients.some(c => c.slot === back.slot)) slot = back.slot
        }
        if (!slot && prev && !clients.some(c => c.slot === prev.slot)) slot = prev.slot
        if (!slot) for (slot = 1; clients.some(c => c.slot === slot) || reserved(slot); slot++);
        client = {
          sock, pid, slot, sessionId,
          name: inherited?.name || took?.name || (sessionId && loadNames()[sessionId]) || prev?.name || '',
          model: inherited?.model || took?.model || prev?.model || '', status: '', lastActive: Date.now(), replaced: old, closing: false,
          nameTries: 0, nameTimer: null,
        }
        clients.push(client)
        // A fork (/model, /clear …) gets a new conversation id: keep the name.
        if (inherited?.name || took?.name) saveName(client)
        const replaces = inherited?.pid ?? took?.pid
        log(`session ${slot} connected (pid ${client.pid}${replaces ? `, replaces ${replaces}` : ''}${old ? ', replaced' : ''}${back ? ', reconnected' : ''})`)
        expectReady = expectReady.filter(e => e.until > Date.now())
        const ready = !inherited && !took && !back && !old ? expectReady.shift() : undefined
        if (ready && ready === opening) opening = null
        if (ready) client.model ||= ready.model
        if (ready?.name && !client.name) {
          client.name = ready.name
          saveName(client)
        }
        // After a relay restart, the session that was active stays active.
        const wasActive = restarting() && [pid, took?.pid].includes(restart!.active ?? -1)
        // A brief reconnect gets the active spot back only if it had it; it doesn't steal it.
        const activate = back ? back.wasActive || !active : !restarting() || !active || wasActive || (inherited && inherited === active)
        if (!old && activate) setActive(client)
        else pushState()
        syncPins()
        flushWaiting()
        const c = client
        if (ready?.announce && ready.updates.length === 0) notify(`Session ${label(c)} is ready (${modelLabel(ready.model)}).`)
        for (const r of ready?.updates ?? []) deliver(c, r)
        for (const ms of [0, 5000, 20000, 60000]) setTimeout(() => void refresh(c), ms)
      } else if (msg.t === 'sent' && client) {
        owners.set(`${msg.chat}:${msg.id}`, client.pid)
        if (owners.size > 5000) owners.delete(owners.keys().next().value!)
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => {
      if (!client || exiting) return
      const c = client
      clients.splice(clients.indexOf(c), 1)
      log(`session ${c.slot} disconnected (pid ${c.pid})`)
      const wasActive = active === c
      if (wasActive) {
        const next = [...clients].sort((a, b) => b.lastActive - a.lastActive)[0] ?? null
        setActive(next)
        if (!next) rmSync(BOT_PID, { force: true })
      } else {
        pushState()
      }
      syncPins(c.closing ? 0 : GRACE_MS)
      if (c.replaced) return
      const autoNew = c.closing && !active && AUTO_NEW && !!NEW_CMD && !!DEFAULT_MODEL &&
        Date.now() - lastAutoNew > AUTO_NEW_MS
      if (autoNew) {
        lastAutoNew = Date.now()
        notify(`Session ${label(c)} closed. Opening a fresh session on ${modelLabel(DEFAULT_MODEL)}…`)
        expectReady.push({ model: DEFAULT_MODEL, until: Date.now() + READY_MS, announce: true, updates: [] })
        void runWith(NEW_CMD!, [DEFAULT_MODEL], undefined, true)
        return
      }
      const tell = () => notify(
        `Session ${label(c)} closed. ` +
        (active ? `Now talking to ${label(active)}.` : 'No sessions open; start one with /new.'),
      )
      if (c.closing || !c.sessionId) return tell()
      const id = c.sessionId
      if (gone.has(id)) clearTimeout(gone.get(id)!.timer)
      gone.set(id, { slot: c.slot, wasActive, timer: setTimeout(() => { gone.delete(id); tell() }, GRACE_MS) })
    })
  })
  server.on('error', err => {
    log(`socket error: ${err}`)
    process.exit(1)
  })
  server.listen(SOCK)
  log(`relay ${VERSION} listening on ${SOCK}`)

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('unhandledRejection', err => log(`unhandled rejection: ${err}`))

  // ---- polling ---------------------------------------------------------

  for (let attempt = 1; !exiting; attempt++) {
    try {
      // Telegram keeps the last allowed_updates any getUpdates caller sent for this token. Another
      // tool polling with ['message'] would silently stop button taps, so always ask for both.
      const updates = await api.getUpdates({ offset, timeout: 30, allowed_updates: ['message', 'callback_query'] })
      attempt = 0
      for (const u of updates) {
        offset = u.update_id + 1
        await route(u).catch(err => log(`route failed: ${err}`))
      }
    } catch (err) {
      if (exiting) break
      const delay = Math.min(1000 * attempt, 15000)
      log(`polling error: ${err}, retrying in ${delay / 1000}s`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

if (import.meta.main) await runRelay()
