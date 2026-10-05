import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveConfig } from './talk.ts'
import { say, transcribe, wrapWav } from './voice.ts'

function silentWav(): string {
  const dir = mkdtempSync(join(tmpdir(), 'talk-stt-'))
  writeFileSync(join(dir, 'x.raw'), Buffer.alloc(3200))   // 100 ms of 16 kHz silence
  wrapWav(join(dir, 'x.raw'), join(dir, 'x.wav'))
  return join(dir, 'x.wav')
}

test('transcribe: posts multipart to TALK_STT_URL and returns the trimmed text', async () => {
  const seen: Record<string, unknown> = {}
  const srv = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      seen.auth = req.headers.get('authorization')
      const f = await req.formData()
      const file = f.get('file') as File
      seen.file = { name: file.name, type: file.type, size: file.size }
      seen.language = f.get('language'); seen.format = f.get('response_format'); seen.model = f.get('model')
      return Response.json({ text: ' hello  world ' })
    },
  })
  try {
    const cfg = { ...resolveConfig('', {}, '/h'), TALK_STT_URL: `http://127.0.0.1:${srv.port}/inference`, TALK_STT_TOKEN: 'secret', TALK_STT_LANG: 'auto' }
    expect(await transcribe(cfg, silentWav())).toBe('hello world')
    expect(seen.auth).toBe('Bearer secret')
    expect(seen.file).toMatchObject({ name: 'x.wav', size: 44 + 3200 })
    expect((seen.file as any).type).toMatch(/^audio\/(x-)?wav$/)   // Bun's parser maps .wav to audio/x-wav
    expect(seen.language).toBe('auto')
    expect(seen.format).toBe('json')
    expect(seen.model).toBe('whisper-1')
  } finally { srv.stop(true) }
})

test('transcribe: language falls back to TALK_LANG, no auth header without a token', async () => {
  const seen: Record<string, unknown> = {}
  const srv = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) { seen.auth = req.headers.get('authorization'); seen.language = (await req.formData()).get('language'); return Response.json({ text: 'ok' }) } })
  try {
    const cfg = { ...resolveConfig('TALK_LANG=el', {}, '/h'), TALK_STT_URL: `http://127.0.0.1:${srv.port}/inference` }
    expect(await transcribe(cfg, silentWav())).toBe('ok')
    expect(seen.auth).toBeNull()
    expect(seen.language).toBe('el')
  } finally { srv.stop(true) }
})

test('transcribe: server failure falls back to whisper-cli (here: TALK_MODEL missing surfaces)', async () => {
  const srv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('boom', { status: 500 }) })
  try {
    const cfg = { ...resolveConfig('', {}, '/h'), TALK_STT_URL: `http://127.0.0.1:${srv.port}/inference`, TALK_MODEL: '/nonexistent/ggml.bin' }
    await expect(transcribe(cfg, silentWav())).rejects.toThrow('TALK_MODEL not found: /nonexistent/ggml.bin')
  } finally { srv.stop(true) }
})

test('stt defaults', () => {
  const c = resolveConfig('', {}, '/h')
  expect([c.TALK_STT_URL, c.TALK_STT_LANG, c.TALK_STT_TOKEN, c.TALK_STT_TIMEOUT_MS, c.TALK_STT_MODEL]).toEqual(['', '', '', '20000', 'whisper-1'])
})

// --- kokoro: fake warm server on a unix socket; TALK_PLAYER=tee records what would be played ---
function kokoroCfg(dir: string, extra = '') {
  return { ...resolveConfig(`TALK_TTS=kokoro\n${extra}`, {}, '/h'), TALK_PLAYER: `tee ${dir}/{rate}.raw`, TALK_VOICE: '/nonexistent/voice.onnx' }
}
const sockDir = () => mkdtempSync(join(tmpdir(), 'talk-k-'))   // short: AF_UNIX paths max out at 108 bytes

test('kokoro: request line sent, streamed PCM reaches the player at 24 kHz', async () => {
  const dir = sockDir(), sock = join(dir, 'k.sock'), pcm = Buffer.alloc(9600, 7)
  let req = ''
  const srv = Bun.listen({ unix: sock, socket: { data(s, d) { req += d; if (req.endsWith('\n')) { s.write(pcm.subarray(0, 4800)); s.write(pcm.subarray(4800)); s.end() } } } })
  try {
    const speech = await say(kokoroCfg(dir, 'TALK_SPEED=1.2'), 'Hello there.', sock)
    expect(await speech.exited).toBe(0)
    expect(JSON.parse(req)).toEqual({ text: 'Hello there.', sid: 3, speed: 1.2 })
    expect(readFileSync(join(dir, '24000.raw'))).toEqual(pcm)
  } finally { srv.stop(true) }
})

test('kokoro: server closes without audio → piper fallback (here: TALK_VOICE missing surfaces)', async () => {
  const dir = sockDir(), sock = join(dir, 'k.sock')
  const srv = Bun.listen({ unix: sock, socket: { data(s) { s.end() } } })
  try { await expect(say(kokoroCfg(dir), 'hi', sock)).rejects.toThrow('TALK_VOICE not found: /nonexistent/voice.onnx') }
  finally { srv.stop(true) }
})

test('kokoro: no server and no model → piper fallback, nothing spawned', async () => {
  const dir = sockDir()
  await expect(say(kokoroCfg(dir, 'TALK_KOKORO_MODEL=/nonexistent/k.onnx'), 'hi', join(dir, 'k.sock'))).rejects.toThrow('TALK_VOICE not found')
})

test('TALK_TTS=piper never touches the kokoro socket', async () => {
  const dir = sockDir(), sock = join(dir, 'k.sock')
  let connects = 0
  const srv = Bun.listen({ unix: sock, socket: { open() { connects++ }, data() {} } })
  try {
    await expect(say({ ...kokoroCfg(dir), TALK_TTS: 'piper' }, 'hi', sock)).rejects.toThrow('TALK_VOICE not found')
    expect(connects).toBe(0)
  } finally { srv.stop(true) }
})
