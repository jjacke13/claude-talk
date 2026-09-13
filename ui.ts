// Companion UI: a local page (ui.html) with an orb that mirrors the conversation. TALK_UI=on makes
// the channel server serve it on 127.0.0.1:TALK_UI_PORT — GET / (page), /events (SSE), /state (JSON).
// The rest of the server reports through the tiny emitters below; when the UI is off they are no-ops.
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { SAY_PID, STATE_DIR, alive, log, type Config } from './voice.ts'

export type UiState = 'idle' | 'listening' | 'thinking' | 'speaking'
export type UiEvent =
  | { type: 'state'; state: UiState }
  | { type: 'user'; text: string; ts: number }
  | { type: 'assistant'; text: string; ts: number }
  | { type: 'context'; pct: number }
export type Signal = 'press' | 'wake' | 'user' | 'speaking' | 'silent' | 'timeout'

export const TRANSCRIPT_MAX = 50
const SAY_POLL_MS = 200, CONTEXT_POLL_MS = 10_000
const LISTEN_TIMEOUT_MS = 30_000, THINK_TIMEOUT_MS = 120_000   // nothing heard / answered in text only

// --- pure ------------------------------------------------------------------------------------

export function pushEvent(ring: readonly UiEvent[], ev: UiEvent, max = TRANSCRIPT_MAX): UiEvent[] {
  const next = [...ring, ev]
  return next.length > max ? next.slice(next.length - max) : next
}

export const sseFrame = (ev: UiEvent): string => `data: ${JSON.stringify(ev)}\n\n`

// press/wake start listening; a delivered user text means Claude is thinking; say.pid alive means
// speaking; its end returns to idle only from speaking (thinking waits for the answer); a timeout
// clears listening/thinking that never resolved, never real speech.
export function reduceState(prev: UiState, s: Signal): UiState {
  switch (s) {
    case 'press': case 'wake': return 'listening'
    case 'user': return 'thinking'
    case 'speaking': return 'speaking'
    case 'silent': return prev === 'speaking' ? 'idle' : prev
    case 'timeout': return prev === 'speaking' ? prev : 'idle'
  }
}

// --- server ----------------------------------------------------------------------------------

let state: UiState = 'idle'
let transcript: UiEvent[] = []
let contextPct: number | undefined
let active = false
let timer: ReturnType<typeof setTimeout> | undefined
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const enc = new TextEncoder()

function broadcast(ev: UiEvent): void {
  if (ev.type === 'user' || ev.type === 'assistant') transcript = pushEvent(transcript, ev)
  const frame = enc.encode(sseFrame(ev))
  for (const c of clients) try { c.enqueue(frame) } catch { clients.delete(c) }
}

function signal(s: Signal): void {
  if (!active) return
  const next = reduceState(state, s)
  if (timer) { clearTimeout(timer); timer = undefined }
  if (next === 'listening') timer = setTimeout(() => signal('timeout'), LISTEN_TIMEOUT_MS)
  if (next === 'thinking') timer = setTimeout(() => signal('timeout'), THINK_TIMEOUT_MS)
  if (next === state) return
  state = next
  broadcast({ type: 'state', state })
}

export const uiListening = (how: 'press' | 'wake' = 'press'): void => signal(how)
export function uiUser(text: string): void { if (!active) return; broadcast({ type: 'user', text, ts: Date.now() }); signal('user') }
export function uiAssistant(text: string): void { if (active) broadcast({ type: 'assistant', text, ts: Date.now() }) }

// Newest context-* file in the state dir holds a percentage written by an external Stop hook.
function readContext(): number | undefined {
  try {
    const name = readdirSync(STATE_DIR).filter(n => n.startsWith('context-')).sort().pop()
    if (!name) return
    const pct = Number(readFileSync(join(STATE_DIR, name), 'utf8').trim())
    return Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : undefined
  } catch { return }
}

function snapshot(): string {
  return JSON.stringify({ state, context: contextPct, events: transcript })
}

function events(): Response {
  let ctl: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c
      clients.add(c)
      // Late joiner: current state, context and the recent transcript first.
      c.enqueue(enc.encode(sseFrame({ type: 'state', state })))
      if (contextPct !== undefined) c.enqueue(enc.encode(sseFrame({ type: 'context', pct: contextPct })))
      for (const ev of transcript) c.enqueue(enc.encode(sseFrame(ev)))
    },
    cancel() { clients.delete(ctl) },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } })
}

export function startUi(cfg: Config): void {
  if (cfg.TALK_UI !== 'on') return
  const port = Number(cfg.TALK_UI_PORT) || 7590
  let html: string
  try { html = readFileSync(new URL('./ui.html', import.meta.url), 'utf8') } catch (e) { log(`ui off: cannot read ui.html (${e})`); return }
  try {
    Bun.serve({
      hostname: '127.0.0.1', port,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
        if (path === '/events') return events()
        if (path === '/state') return new Response(snapshot(), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
        return new Response('not found', { status: 404 })
      },
    })
  } catch (e) { log(`ui off: cannot listen on 127.0.0.1:${port} (${(e as Error).message}) — set TALK_UI_PORT or free the port`); return }
  active = true
  log(`ui at http://127.0.0.1:${port}`)

  let speaking = alive(SAY_PID)
  if (speaking) signal('speaking')
  setInterval(() => {
    const now = alive(SAY_PID)
    if (now === speaking) return
    speaking = now
    signal(now ? 'speaking' : 'silent')
  }, SAY_POLL_MS)

  const pollContext = () => {
    const pct = readContext()
    if (pct !== undefined && pct !== contextPct) { contextPct = pct; broadcast({ type: 'context', pct }) }
  }
  pollContext()
  setInterval(pollContext, CONTEXT_POLL_MS)
}
