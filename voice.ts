// Side-effecting voice plumbing shared by the bin/ scripts: config from disk+env, piper
// synthesis (raw s16 mono at the voice's sample rate), playback, opus rendering, recording,
// whisper transcription, and the inbox drop. Pure logic lives in talk.ts.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { resolveConfig, type Config } from './talk.ts'

export const STATE_DIR = process.env.TALK_STATE_DIR
  ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'talk')
export const INBOX = join(STATE_DIR, 'inbox')
export const CONFIG_FILE = join(STATE_DIR, 'config')
export const SAY_PID = join(STATE_DIR, 'say.pid')
export const LOG_FILE = join(STATE_DIR, 'talk.log')
try { mkdirSync(INBOX, { recursive: true }) } catch {}   // every script may run before the server ever did

// stderr for the terminal, talk.log for the detached hook path (whose stderr nobody sees).
export const log = (line: string) => {
  process.stderr.write(`talk: ${line}\n`)
  try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`) } catch {}
}

export function loadConfig(): Config {
  const text = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : ''
  return resolveConfig(text, process.env, homedir())
}

export function requireFile(path: string, key: string): void {
  if (!existsSync(path)) { log(`${key} not found: ${path} — set it with /talk:configure`); process.exit(1) }
}

// piper voice sample rate from the sidecar json; 22050 is piper's usual medium-quality rate.
export function voiceRate(voice: string): number {
  try { return Number(JSON.parse(readFileSync(`${voice}.json`, 'utf8')).audio?.sample_rate) || 22050 } catch { return 22050 }
}

// piper reads text on stdin, writes raw s16le mono on stdout.
export function synth(cfg: Config, text: string) {
  requireFile(cfg.TALK_VOICE, 'TALK_VOICE')
  return Bun.spawn(['piper', '--model', cfg.TALK_VOICE, '--output-raw'], { stdin: new Blob([text + '\n']), stdout: 'pipe', stderr: 'ignore' })
}

// Speak now. Returns both children so a SIGTERM to the wrapper can cut the audio.
export function say(cfg: Config, text: string) {
  const piper = synth(cfg, text)
  const rate = String(voiceRate(cfg.TALK_VOICE))
  const player = Bun.spawn([cfg.TALK_PLAYER, '--raw', '--rate', rate, '--channels', '1', '--format', 's16', '-'], { stdin: piper.stdout, stdout: 'ignore', stderr: 'ignore' })
  return { piper, player }
}

// Render to ogg/opus (what SimpleX/Telegram voice bubbles want). Returns duration in seconds.
export async function renderOgg(cfg: Config, text: string, out: string): Promise<number> {
  const p = synth(cfg, text)
  const rate = String(voiceRate(cfg.TALK_VOICE))
  const ff = Bun.spawn(['ffmpeg', '-y', '-loglevel', 'error', '-f', 's16le', '-ar', rate, '-ac', '1', '-i', '-', '-c:a', 'libopus', out], { stdin: p.stdout, stdout: 'ignore', stderr: 'inherit' })
  if (await ff.exited !== 0) { log('ffmpeg failed'); process.exit(1) }
  const probe = Bun.spawn(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { stdout: 'pipe' })
  return Math.round(Number((await new Response(probe.stdout).text()).trim())) || 0
}

// Record 16 kHz mono WAV until `stop` resolves (Enter pressed or timer).
export async function record(wav: string, stop: Promise<unknown>): Promise<void> {
  const rec = Bun.spawn(['pw-record', '--rate', '16000', '--channels', '1', '--format', 's16', wav], { stdout: 'ignore', stderr: 'inherit' })
  await stop
  rec.kill('SIGINT')
  await rec.exited
}

export async function transcribe(cfg: Config, wav: string): Promise<string> {
  requireFile(cfg.TALK_MODEL, 'TALK_MODEL')
  const w = Bun.spawn(['whisper-cli', '-m', cfg.TALK_MODEL, '-l', cfg.TALK_LANG, '-f', wav, '-nt', '-np'], { stdout: 'pipe', stderr: 'ignore' })
  const text = (await new Response(w.stdout).text()).replace(/\s+/g, ' ').trim()
  if (await w.exited !== 0) { log('whisper-cli failed'); process.exit(1) }
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

// Start recording without waiting; caller kills with SIGINT (pw-record then finalizes the WAV).
export function startRecording(wav: string) {
  return Bun.spawn(['pw-record', '--rate', '16000', '--channels', '1', '--format', 's16', wav], { stdout: 'ignore', stderr: 'ignore' })
}
