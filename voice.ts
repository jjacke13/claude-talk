// Side-effecting voice plumbing shared by the bin/ scripts: config from disk+env, piper
// synthesis (raw s16 mono at the voice's sample rate), playback, opus rendering, recording,
// whisper transcription, and the inbox drop. Pure logic lives in talk.ts.
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { resolveConfig, splitCmd, type Config } from './talk.ts'

export const STATE_DIR = process.env.TALK_STATE_DIR
  ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'talk')
export const INBOX = join(STATE_DIR, 'inbox')
export const CONFIG_FILE = join(STATE_DIR, 'config')
export const SAY_PID = join(STATE_DIR, 'say.pid')
export const LOG_FILE = join(STATE_DIR, 'talk.log')
try { mkdirSync(INBOX, { recursive: true }) } catch {}   // every script may run before the server ever did

// stderr for the terminal, talk.log for the detached hook path (whose stderr nobody sees).
const LOG_MAX = 1 << 20   // ponytail: rotate once at 1 MB (keep .1), enough history for a bug report
export const log = (line: string) => {
  process.stderr.write(`talk: ${line}\n`)
  try {
    if (statSync(LOG_FILE).size > LOG_MAX) renameSync(LOG_FILE, LOG_FILE + '.1')
  } catch {}
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`) } catch {}
}

export function loadConfig(): Config {
  const text = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : ''
  return resolveConfig(text, process.env, homedir(), process.platform)
}

export function requireFile(path: string, key: string): void {
  if (!existsSync(path)) throw new Error(`${key} not found: ${path} — set it with /talk:configure`)
}

// piper voice sample rate from the sidecar json; 22050 is piper's usual medium-quality rate.
export function voiceRate(voice: string): number {
  try { return Number(JSON.parse(readFileSync(`${voice}.json`, 'utf8')).audio?.sample_rate) || 22050 } catch { return 22050 }
}

// piper reads text on stdin, writes raw s16le mono on stdout.
export function synth(cfg: Config, text: string) {
  requireFile(cfg.TALK_VOICE, 'TALK_VOICE')
  // TALK_SPEED 1.0 = the voice's natural rate; piper's length-scale is its inverse (0.5–3 clamp).
  const speed = Math.min(3, Math.max(0.5, Number(cfg.TALK_SPEED) || 1))
  return Bun.spawn(['piper', '--model', cfg.TALK_VOICE, '--output-raw', '--length-scale', String(1 / speed)], { stdin: new Blob([text + '\n']), stdout: 'pipe', stderr: 'ignore' })
}

// Speak now. Returns both children so a SIGTERM to the wrapper can cut the audio.
export function say(cfg: Config, text: string) {
  const piper = synth(cfg, text)
  const rate = String(voiceRate(cfg.TALK_VOICE))
  const player = Bun.spawn(splitCmd(cfg.TALK_PLAYER, { rate }), { stdin: piper.stdout, stdout: 'ignore', stderr: 'ignore' })
  return { piper, player }
}

// Render to ogg/opus (what SimpleX/Telegram voice bubbles want). Returns duration in seconds.
export async function renderOgg(cfg: Config, text: string, out: string): Promise<number> {
  const p = synth(cfg, text)
  const rate = String(voiceRate(cfg.TALK_VOICE))
  const ff = Bun.spawn(['ffmpeg', '-y', '-loglevel', 'error', '-f', 's16le', '-ar', rate, '-ac', '1', '-i', '-', '-c:a', 'libopus', out], { stdin: p.stdout, stdout: 'ignore', stderr: 'inherit' })
  if (await ff.exited !== 0) throw new Error('ffmpeg failed')
  const probe = Bun.spawn(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { stdout: 'pipe' })
  return Math.round(Number((await new Response(probe.stdout).text()).trim())) || 0
}

// Record raw s16le 16 kHz mono until `stop` resolves (Enter pressed or timer), then wrap as WAV.
export async function record(cfg: Config, wav: string, stop: Promise<unknown>): Promise<void> {
  const rec = startRecording(cfg, wav)
  await stop
  await stopRecording(rec, wav)
}

// Raw → WAV: 44-byte RIFF header. Killing the recorder at any moment leaves a valid raw stream,
// which is why we never let the recorder write the container itself.
export function wrapWav(raw: string, wav: string, rate = 16000): void {
  const pcm = readFileSync(raw)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  writeFileSync(wav, Buffer.concat([h, pcm]))
  try { unlinkSync(raw) } catch {}
}

export async function transcribe(cfg: Config, wav: string): Promise<string> {
  requireFile(cfg.TALK_MODEL, 'TALK_MODEL')
  const w = Bun.spawn(['whisper-cli', '-m', cfg.TALK_MODEL, '-l', cfg.TALK_LANG, '-f', wav, '-nt', '-np'], { stdout: 'pipe', stderr: 'ignore' })
  const text = (await new Response(w.stdout).text()).replace(/\s+/g, ' ').trim()
  if (await w.exited !== 0) throw new Error('whisper-cli failed')
  return text
}

// Atomic drop: tmp + rename, so the server never reads a half-written file.
export function drop(text: string): string {
  mkdirSync(INBOX, { recursive: true })
  const name = `${Date.now()}.txt`
  writeFileSync(join(INBOX, `${name}.tmp`), text + '\n')
  renameSync(join(INBOX, `${name}.tmp`), join(INBOX, name))
  return name
}

// Modality marker: bin/talk sets it; the Stop hook consumes it to decide whether to speak.
export const SPOKEN_MARK = join(STATE_DIR, 'spoken')
export function markSpoken(): void { try { writeFileSync(SPOKEN_MARK, String(Date.now())) } catch {} }
export function takeSpoken(maxAgeMs = 10 * 60_000): boolean {
  try {
    const fresh = Date.now() - Number(readFileSync(SPOKEN_MARK, 'utf8')) < maxAgeMs
    unlinkSync(SPOKEN_MARK)
    return fresh
  } catch { return false }
}

// Start the recorder writing raw PCM to `<wav>.raw`; stopRecording() kills it and wraps the WAV.
export function startRecording(cfg: Config, wav: string) {
  return Bun.spawn(splitCmd(cfg.TALK_RECORDER, { raw: wav + '.raw' }), { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
}
export async function stopRecording(rec: ReturnType<typeof startRecording>, wav: string): Promise<void> {
  rec.kill(process.platform === 'win32' ? undefined : 'SIGINT')
  await rec.exited
  wrapWav(wav + '.raw', wav)
}

// Queue speech behind whatever `say` is still playing (or cut it off when interrupt=true).
// Detached: the caller (a hook or the MCP server) never waits for the audio.
export function enqueueSpeech(text: string, interrupt = false): number {
  let after = ''
  try {
    const pid = Number(readFileSync(SAY_PID, 'utf8'))
    if (interrupt) process.kill(pid, 'SIGTERM'); else after = String(pid)
  } catch {}
  const logFd = openSync(LOG_FILE, 'a')
  const args = ['bun', new URL('./bin/say', import.meta.url).pathname, ...(after ? ['--after', after] : []), text]
  const p = Bun.spawn(args, { stdin: 'ignore', stdout: 'ignore', stderr: logFd })
  p.unref()
  writeFileSync(SAY_PID, String(p.pid))
  return p.pid
}

// Texts spoken via the `speak` tool this turn, so the Stop hook does not read them again.
export const SPOKEN_LOG = join(STATE_DIR, 'spoken.log')
export function noteSpoken(text: string): void { try { appendFileSync(SPOKEN_LOG, text.replace(/\s+/g, ' ').trim() + '\n') } catch {} }
export function readSpoken(): Set<string> { try { return new Set(readFileSync(SPOKEN_LOG, 'utf8').split('\n').filter(Boolean)) } catch { return new Set() } }
export function clearSpoken(): void { try { unlinkSync(SPOKEN_LOG) } catch {} }
