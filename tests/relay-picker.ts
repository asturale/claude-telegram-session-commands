// E2E test for the relay's "which session?" picker: a mock Bot API and two fake sessions on relay.sock,
// in a temporary state dir (never touches a real bot). Needs the dependencies installed (bun install).
// Usage: bun run tests/relay-picker.ts "$PWD/relay.ts"
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createConnection } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

const RELAY = process.argv[2]
const VERSION = createHash('sha256').update(readFileSync(RELAY)).digest('hex').slice(0, 12)
const dir = mkdtempSync(join(tmpdir(), 'picker-'))
writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111'] }))

const queue: any[] = []
const calls: { method: string, body: any }[] = []
let nextId = 5000, updId = 1
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()!
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    calls.push({ method, body })
    if (method === 'getUpdates') {
      for (let i = 0; i < 20 && !queue.length; i++) await Bun.sleep(50)
      const out = queue.splice(0).map(u => ({ update_id: updId++, ...u }))
      return Response.json({ ok: true, result: out })
    }
    if (method === 'sendMessage') {
      return Response.json({ ok: true, result: { message_id: nextId++, date: 0, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text } })
    }
    return Response.json({ ok: true, result: true })
  },
})

const env: Record<string, string> = {
  PATH: process.env.PATH!, HOME: process.env.HOME!,
  TELEGRAM_STATE_DIR: dir, TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_API_ROOT: `http://127.0.0.1:${server.port}`,
  TELEGRAM_NEW_CMD: '/bin/true', TELEGRAM_DEFAULT_MODEL: 'test-model', TELEGRAM_MODELS: 'Test=test-model',
}
const relay = spawn(process.execPath, [RELAY], { env, cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] })

const sleepers = [spawn('sleep', ['120']), spawn('sleep', ['120'])]
type Fake = { pid: number, got: any[], sock: ReturnType<typeof createConnection> }
const fakes: Fake[] = []
const connectFake = (pid: number) => new Promise<Fake>(resolve => {
  const f: Fake = { pid, got: [], sock: createConnection(join(dir, 'relay.sock')) }
  let buf = ''
  f.sock.setEncoding('utf8')
  f.sock.on('data', (d: string) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1)
      if (m.t === 'update') f.got.push(m.update)
    }
  })
  f.sock.on('connect', () => {
    f.sock.write(JSON.stringify({ t: 'hello', pid, version: VERSION, sessionId: `s-${pid}` }) + '\n')
    resolve(f)
  })
})

let failed = 0
const check = (name: string, ok: boolean, info?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info)}`)
  if (!ok) failed++
}
const wait = async (cond: () => boolean, ms = 4000) => {
  for (let t = 0; t < ms && !cond(); t += 50) await Bun.sleep(50)
  return cond()
}
const chat = { id: 111, type: 'private' }
const from = { id: 111, is_bot: false, first_name: 'K' }
const botMsg = (id: number, text: string) => ({ message_id: id, date: 0, chat, from: { id: 1, is_bot: true, first_name: 'Bot' }, text })
const sends = () => calls.filter(c => c.method === 'sendMessage')
const picker = () => sends().find(c => String(c.body.text).startsWith('That message did not come'))

try {
  for (let i = 0; i < 100; i++) {
    try { readFileSync(join(dir, 'relay.pid')); break } catch { await Bun.sleep(50) }
  }
  await Bun.sleep(300)
  fakes.push(await connectFake(sleepers[0].pid!))
  await Bun.sleep(200)
  fakes.push(await connectFake(sleepers[1].pid!))
  await Bun.sleep(500)

  // 1. Reply to a script message with two sessions open: picker, nobody gets it yet.
  queue.push({ message: { message_id: 10, date: 0, chat, from, text: 'archive it', reply_to_message: botMsg(9000, 'CI-autofix: foo failed') } })
  await wait(() => !!picker())
  const p = picker()
  const kb = p?.body.reply_markup?.inline_keyboard ?? []
  check('picker sent', !!p, sends().map(s => s.body.text))
  check('picker lists both sessions + new', kb.length === 3 && kb[2][0].callback_data === 'relay:pick:new', kb)
  check('no session got the reply yet', fakes.every(f => f.got.length === 0), fakes.map(f => f.got.length))
  const pickerId = 5000 + sends().indexOf(p!)

  // 2. Tap session 2: it gets the original reply, session 1 doesn't.
  const tap = (id: string, data: string) => queue.push({ callback_query: { id, from, chat_instance: 'x', data, message: { message_id: pickerId, date: 0, chat, from: { id: 1, is_bot: true, first_name: 'Bot' }, text: 'That message did not come…' } } })
  tap('q1', `relay:pick:${fakes[1].pid}`)
  await wait(() => fakes[1].got.length > 0)
  check('session 2 got the reply', fakes[1].got[0]?.message?.text === 'archive it' && fakes[1].got[0]?.message?.reply_to_message?.message_id === 9000, fakes[1].got)
  check('session 1 got nothing', fakes[0].got.length === 0, fakes[0].got)
  check('picker edited', calls.some(c => c.method === 'editMessageText' && String(c.body.text).startsWith('→ Sent to')))

  // 3. A second tap on the same picker does nothing.
  tap('q2', `relay:pick:${fakes[0].pid}`)
  await wait(() => calls.some(c => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'q2'))
  check('second tap: already handled', calls.some(c => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'q2' && c.body.text === 'Already handled.') && fakes[0].got.length === 0)

  // 4. A reply to a message a session sent still goes straight to that session.
  fakes[0].sock.write(JSON.stringify({ t: 'sent', chat: 111, id: 9100 }) + '\n')
  await Bun.sleep(200)
  const before = sends().length
  queue.push({ message: { message_id: 11, date: 0, chat, from, text: 'ok', reply_to_message: botMsg(9100, 'from session 1') } })
  await wait(() => fakes[0].got.length > 0)
  check('owned reply goes direct', fakes[0].got[0]?.message?.text === 'ok' && sends().length === before, fakes[0].got)

  // 5. Picker → New session.
  queue.push({ message: { message_id: 12, date: 0, chat, from, text: 'fix this', reply_to_message: botMsg(9001, 'Alert: disk full') } })
  await wait(() => sends().filter(s => String(s.body.text).startsWith('That message did not come')).length === 2)
  const p2 = sends().filter(s => String(s.body.text).startsWith('That message did not come'))[1]
  const p2Id = 5000 + sends().indexOf(p2)
  queue.push({ callback_query: { id: 'q3', from, chat_instance: 'x', data: 'relay:pick:new', message: { message_id: p2Id, date: 0, chat, from: { id: 1, is_bot: true, first_name: 'Bot' }, text: 'x' } } })
  await wait(() => sends().some(s => String(s.body.text).startsWith('Opening a new session')))
  check('new session opened', sends().some(s => String(s.body.text).startsWith('Opening a new session')), sends().map(s => s.body.text))

  // 6. With one session left, a reply to a script message goes straight to it.
  fakes[1].sock.destroy()
  await Bun.sleep(500)
  const n0 = fakes[0].got.length, s0 = sends().length
  queue.push({ message: { message_id: 13, date: 0, chat, from, text: 'single', reply_to_message: botMsg(9002, 'CI-autofix: bar') } })
  await wait(() => fakes[0].got.length > n0, 3000)
  check('single session: direct', fakes[0].got.at(-1)?.message?.text === 'single' && !sends().slice(s0).some(s => String(s.body.text).startsWith('That message did not come')), { got: fakes[0].got.at(-1), sends: sends().slice(s0).map(s => s.body.text) })
} finally {
  relay.kill(); sleepers.forEach(s => s.kill()); server.stop(true)
  console.log(failed ? `${failed} FAILED` : 'ALL PASS')
  process.exit(failed ? 1 : 0)
}
