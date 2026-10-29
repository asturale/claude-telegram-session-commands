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
 *   /sessions          list sessions; tap one to switch, ✕ to close it
 *   /new [prompt]      pick a model, then `TELEGRAM_NEW_CMD <model> [prompt]`
 *   /close             close the active session (`TELEGRAM_CLOSE_CMD`)
 *   /name [name]       name the active session (empty: back to the model name)
 * Names are kept per conversation in session-names.json, so scripts (such as a
 * /resume picker) can show them too, and carry over to a session's replacement.
 * With TELEGRAM_AUTO_NEW=1, closing the last session through /close or ✕ opens
 * a fresh one on TELEGRAM_DEFAULT_MODEL (default: the first TELEGRAM_MODELS
 * entry); at most once a minute, and never after a crash.
 * Commands run with TELEGRAM_SESSION_PID set to the server.ts pid of the
 * session they concern (for /new: the active one, to copy settings from).
 * TELEGRAM_SESSION_INFO_CMD, run the same way, prints JSON with optional
 * "model" and "status" ("busy"/"idle") for labels and the session list.
 * TELEGRAM_PIN_CMD runs whenever the active session changes, with no
 * arguments for the new active session or `--none` when none is left: for
 * pinning it, so the daemon does not retire it while idle.
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
import { readFileSync, writeFileSync, rmSync, openSync, statSync } from 'fs'
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
const RELAY_PATH = import.meta.path
const VERSION = createHash('sha256').update(readFileSync(RELAY_PATH)).digest('hex').slice(0, 12)

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
    { command: 'close', description: 'Close the active session', help: '/close — close the active session' },
    { command: 'name', description: 'Name the active session', help: '/name [name] — name the active session (empty: model name)' },
  )

  let state = { label: '', active: true, multi: false }
  let sock: Socket | null = null
  let lastSpawn = 0

  // Tag messages and report what we sent, so taps and swipe-replies on them
  // find their way back to this session.
  bot.api.config.use(async (prev, method, payload, signal) => {
    const p = payload as Msg
    if (state.multi && (method === 'sendMessage' || method === 'editMessageText') && typeof p.text === 'string') {
      const tag = p.parse_mode === 'MarkdownV2'
        ? `\\[${state.label.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')}\\] `
        : `[${state.label}] `
      if (!p.text.startsWith(tag) && p.text.length + tag.length <= 4096) {
        payload = { ...payload, text: tag + p.text }
      }
      if (method === 'sendMessage' && !state.active && !p.reply_markup) {
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
    void bot.api.setMyCommands(
      [
        { command: 'start', description: 'Welcome and setup guide' },
        { command: 'help', description: 'What this bot can do' },
        { command: 'status', description: 'Check your pairing status' },
        ...o.menu.map(({ command, description }) => ({ command, description })),
      ],
      { scope: { type: 'all_private_chats' } },
    ).catch(() => {})
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
  let pinned: number | null | undefined // pid last handed to PIN_CMD
  let pinning = Promise.resolve('')
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

  // TELEGRAM_API_ROOT: a stand-in Bot API, for testing.
  const api = new Api(TOKEN, process.env.TELEGRAM_API_ROOT ? { apiRoot: process.env.TELEGRAM_API_ROOT } : undefined)
  const clients: Client[] = []
  let active: Client | null = null
  let offset = 0
  let exiting = false
  const owners = new Map<string, number>() // `${chat}:${message_id}` → client pid
  const pendingNew = new Map<string, string>() // `${chat}:${message_id}` → prompt
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
  const shortModel = (m: string) => m.replace(/\[.*\]$/, '').replace(/^claude-/, '').replace(/[-.\d]+$/, '')
  const label = (c: Client) =>
    c.name ? `${c.slot}·${c.name}` : c.model ? `${c.slot}·${shortModel(c.model)}` : `${c.slot}`
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
    if (c) {
      c.lastActive = Date.now()
      try {
        writeFileSync(BOT_PID, String(c.pid))
      } catch {}
    }
    pushState()
    // One at a time, in order: each run unpins what the previous one pinned.
    const pid = c?.pid ?? null
    if (PIN_CMD && pid !== pinned) {
      pinned = pid
      pinning = pinning.then(() => runWith(PIN_CMD, pid ? [] : ['--none'], pid ?? undefined, false))
    }
  }

  const runWith = (cmd: string, args: string[], pid: number | undefined, detached: boolean): Promise<string> => {
    const env = { ...process.env, ...(pid ? { TELEGRAM_SESSION_PID: String(pid) } : {}) }
    if (detached) {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env })
      child.on('error', err => log(`${cmd} failed: ${err}`))
      child.unref()
      return Promise.resolve('')
    }
    return new Promise(resolve => {
      execFile(cmd, args, { timeout: 20000, encoding: 'utf8', env }, (_err, stdout) => resolve(stdout ?? ''))
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

  const deliver = (c: Client, u: Update) => writeLine(c.sock, { t: 'update', update: u })

  const flushWaiting = () => {
    if (!active) return
    for (const u of waiting) deliver(active, u)
    waiting = []
    if (waitTimer) clearTimeout(waitTimer)
    waitTimer = null
  }

  // ---- relay commands --------------------------------------------------

  const sessionsList = async (chat: string) => {
    if (clients.length === 0) {
      await api.sendMessage(chat, 'No sessions open. Start one with /new.').catch(() => {})
      return
    }
    await Promise.race([Promise.all(clients.map(refresh)), new Promise(r => setTimeout(r, 10000))])
    const rows = [...clients].sort((a, b) => a.slot - b.slot).map(c => [
      {
        text: `${c === active ? '● ' : ''}${label(c)}${c.name && c.model ? ` (${shortModel(c.model)})` : ''}${c.status ? ` · ${statusText(c)}` : ''}`,
        callback_data: `relay:use:${c.pid}`,
      },
      { text: '✕', callback_data: `relay:ask:${c.pid}` },
    ])
    if (NEW_CMD) rows.push([{ text: '+ New session', callback_data: 'relay:newmenu' }])
    await api.sendMessage(chat, 'Sessions (● = active). Tap to switch, ✕ to close:', {
      reply_markup: { inline_keyboard: rows },
    }).catch(e => log(`sessions failed: ${e}`))
  }

  const newMenu = async (chat: string, prompt: string) => {
    if (!NEW_CMD) {
      await api.sendMessage(chat, '/new is not configured (TELEGRAM_NEW_CMD).').catch(() => {})
      return
    }
    const sent = await api.sendMessage(chat, 'Open a new session on:', {
      reply_markup: { inline_keyboard: [MODELS.map((m, i) => ({ text: m.label, callback_data: `relay:new:${i}` }))] },
    }).catch(() => null)
    if (sent && prompt) pendingNew.set(`${chat}:${sent.message_id}`, prompt)
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

  const handleCommand = async (u: Update): Promise<boolean> => {
    const m = u.message
    if (!m || m.chat.type !== 'private' || !owner(m.from?.id)) return false
    const cm = /^\/(sessions|new|close|name)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(m.text ?? '')
    if (!cm) return false
    const chat = String(m.chat.id)
    if (cm[1] === 'sessions') await sessionsList(chat)
    else if (cm[1] === 'new') await newMenu(chat, (cm[2] ?? '').trim())
    else if (cm[1] === 'name') await nameSession(chat, active, (cm[2] ?? '').trim())
    else await askClose(chat, active)
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
        const prompt = pendingNew.get(key)
        pendingNew.delete(key)
        await answer(`Starting ${model.label}…`)
        await edit(`Opening a new session on ${model.label}…`)
        void runWith(NEW_CMD, prompt ? [model.value, prompt] : [model.value], active?.pid, true)
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
    if (await handleCommand(u)) return
    if (await handleCallback(u)) return

    const q = u.callback_query
    const m = u.message
    if (q?.message) {
      const pid = owners.get(`${q.message.chat.id}:${q.message.message_id}`)
      if (pid != null) {
        const c = byPid(pid)
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
      const c = pid != null ? byPid(pid) : null
      if (c) {
        if (c !== active && m.chat.type === 'private' && owner(m.from?.id)) setActive(c)
        deliver(c, u)
        return
      }
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
    process.exit(0)
  }

  rmSync(SOCK, { force: true })
  const server = createServer(sock => {
    let client: Client | null = null
    onLines(sock, msg => {
      if (msg.t === 'use' && !client) {
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
          // A session runs a newer (or older) relay.ts: make way for it.
          void shutdown(`version ${msg.version} connected, mine is ${VERSION}`)
          return
        }
        let slot = 0
        let inherited: Client | null = null
        try {
          const h = JSON.parse(readFileSync(HANDOVER, 'utf8'))
          if (Date.now() - statSync(HANDOVER).mtimeMs < HANDOVER_MS) inherited = byPid(Number(h.from))
          rmSync(HANDOVER, { force: true })
        } catch {}
        if (inherited) {
          inherited.replaced = true
          slot = inherited.slot
        } else {
          for (slot = 1; clients.some(c => c.slot === slot); slot++);
        }
        const sessionId = String(msg.sessionId ?? '')
        client = {
          sock, pid: Number(msg.pid), slot, sessionId,
          name: inherited?.name || (sessionId && loadNames()[sessionId]) || '',
          model: inherited?.model ?? '', status: '', lastActive: Date.now(), replaced: false, closing: false,
        }
        clients.push(client)
        // A fork (/model, /clear …) gets a new conversation id: keep the name.
        if (inherited?.name) saveName(client)
        log(`session ${slot} connected (pid ${client.pid}${inherited ? `, replaces ${inherited.pid}` : ''})`)
        setActive(client)
        flushWaiting()
        const c = client
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
      if (active === c) {
        const next = [...clients].sort((a, b) => b.lastActive - a.lastActive)[0] ?? null
        setActive(next)
        if (!next) rmSync(BOT_PID, { force: true })
      } else {
        pushState()
      }
      if (c.replaced) return
      const autoNew = c.closing && !active && AUTO_NEW && !!NEW_CMD && !!DEFAULT_MODEL &&
        Date.now() - lastAutoNew > AUTO_NEW_MS
      if (autoNew) {
        lastAutoNew = Date.now()
        const m = MODELS.find(x => x.value === DEFAULT_MODEL)?.label ?? DEFAULT_MODEL
        notify(`Session ${label(c)} closed. Opening a fresh session on ${m}…`)
        void runWith(NEW_CMD!, [DEFAULT_MODEL], undefined, true)
        return
      }
      notify(
        `Session ${label(c)} closed. ` +
        (active ? `Now talking to ${label(active)}.` : 'No sessions open; start one with /new.'),
      )
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
      const updates = await api.getUpdates({ offset, timeout: 30 })
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
