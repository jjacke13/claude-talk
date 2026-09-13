// Wake word: a detector process (bin/wake-detector → openwakeword) hears the mic all the time.
// On "hey claudia": cut current speech, beep, record until silence, transcribe, hand the text
// to `onText` — hold-to-talk without the key. Opt-in (TALK_WAKE=on), Linux only for now.
//
// States (`state` below), one at a time:
//   idle       detector running, nothing recording. Wake word → listening. Claudia's speech
//              ending after any spoken turn (`armed`: wake word or hold key) → followup.
//   listening  recorder on; ends after TALK_WAKE_SILENCE_MS of quiet once speech was heard, or
//              at CAP_MS. Then transcribe → onText → idle (armed).
//   followup   recorder on for TALK_WAKE_FOLLOWUP_S with no beep; speech within it → listening
//              (same recording); silence → idle, disarmed. Claudia speaking again, or the wake
//              word, cancels the window.
import { closeSync, existsSync, openSync, readFileSync, readSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { takeLock } from './hold.ts'
import { beepPcm, listenDone, listenStart, listenStep, rms, splitCmd, type Config, type ListenOpts } from './talk.ts'
import { uiListening } from './ui.ts'
import { LOG_FILE, SAY_PID, STATE_DIR, alive, log, markSpoken, startRecording, stopRecording, transcribe, voiceRate } from './voice.ts'

const LOCK = join(STATE_DIR, 'wake.lock')
const VENV_PY = join(STATE_DIR, 'wake', 'venv', 'bin', 'python')
const DETECTOR = new URL('./bin/wake-detector', import.meta.url).pathname
const MODELS_DIR = new URL('./models/', import.meta.url).pathname
const CAP_MS = 20_000, POLL_MS = 100, SAY_POLL_MS = 300, RESTART_AFTER_MS = 60_000
const GRACE_MS = 500   // the beep's echo and the wake word's tail land here: recorded, but not counted as speech

type State = 'idle' | 'listening' | 'followup'
type Capture = { aborted: boolean; claudia?: boolean }
// A spoken turn happened (wake word here, or the hold key via server.ts): when Claudia's answer
// ends, open the follow-up window. Module-level so hold.ts's callback can arm it without a handle.
let armed = false
export function armFollowUp(): void { armed = true }
// The hold key pressed during an open follow-up window: drop that capture, the key's recorder takes
// over (both hear the same mic; without this the utterance would arrive twice). No-op otherwise.
let cancelCurrent: () => void = () => {}
export function cancelFollowUp(): void { cancelCurrent() }
const rm = (wav: string) => { for (const f of [wav, wav + '.raw']) try { unlinkSync(f) } catch {} }
// A bare name is the plugin's models/<name>.onnx when that exists; otherwise it reaches openwakeword
// as-is (a prebuilt name such as hey_jarvis, or a path). hey_jarvis is the fallback if ours is missing.
export function modelArg(v: string): string {
  const shipped = join(MODELS_DIR, v + '.onnx')
  if (v.includes('/') || v.endsWith('.onnx')) return v
  if (existsSync(shipped)) return shipped
  if (v === 'hey_claudia') { log(`${shipped} missing — using the prebuilt hey_jarvis (say "hey jarvis")`); return 'hey_jarvis' }
  return v
}

export function startWake(cfg: Config, onText: (text: string) => void): void {
  if (cfg.TALK_WAKE !== 'on') return
  if (process.platform !== 'linux') { log('wake word off: Linux only for now'); return }
  if (!existsSync(VENV_PY)) { log(`wake word off: ${VENV_PY} missing — run the "Wake word" setup in README.md`); return }
  if (!takeLock(LOCK)) {
    log('wake word waiting: another talk server owns the mic')
    const t = setInterval(() => { if (takeLock(LOCK)) { clearInterval(t); startWake(cfg, onText) } }, 2000)
    return
  }

  const threshold = Number(cfg.TALK_WAKE_RMS) || 0.01
  const silenceMs = Number(cfg.TALK_WAKE_SILENCE_MS) || 1200
  const followupMs = (Number(cfg.TALK_WAKE_FOLLOWUP_S) || 6) * 1000
  const rate = voiceRate(cfg.TALK_VOICE), tone = beepPcm(rate)
  let state: State = 'idle', cur: Capture | undefined
  let rec: ReturnType<typeof startRecording> | undefined, det: ReturnType<typeof Bun.spawn> | undefined, exiting = false

  // Record to a temp WAV while watching the raw stream's RMS; returns the WAV, or nothing when
  // nobody spoke (or the capture was cancelled). `onSpeech` fires on the first loud chunk.
  async function capture(o: ListenOpts, cap: Capture, onSpeech?: () => void): Promise<string | undefined> {
    const wav = join(tmpdir(), `talk-wake-${process.pid}-${Date.now()}.wav`)
    const r = rec = startRecording(cfg, wav)
    const buf = Buffer.alloc(1 << 16)
    let s = listenStart(Date.now()), off = 0, fd = -1, why: ReturnType<typeof listenDone> = null
    const trace: number[] = []   // per-poll RMS ×1000, logged at the end: the calibration aid for TALK_WAKE_RMS
    while (!why && !cap.aborted) {
      await Bun.sleep(POLL_MS)
      // Claudia started talking mid-capture (a reply to a key turn, or a false wake): the mic
      // would record HER — drop the capture instead of transcribing her as the user (live 2026-09-13).
      if (alive(SAY_PID)) { cap.claudia = true; break }
      try {
        if (fd < 0) fd = openSync(wav + '.raw', 'r')
        const n = readSync(fd, buf, 0, buf.length, off); off += n
        const level = rms(buf.subarray(0, n)); trace.push(Math.round(level * 1000))
        const now = Date.now()
        const next = now - s.t0 < GRACE_MS ? s : listenStep(s, level, now, threshold, n / 32)   // 16 kHz s16 = 32 bytes/ms
        if (!s.heard && next.heard) onSpeech?.()
        s = next
      } catch {}   // the recorder has not created the file yet
      why = listenDone(s, Date.now(), o)
    }
    if (fd >= 0) closeSync(fd)
    await stopRecording(r, wav)
    rec = undefined
    log(`capture ${cap.claudia ? 'dropped (Claudia speaking)' : why ?? 'aborted'}: rms‰ ${trace.join(' ')}`)
    if (why === 'nospeech' || cap.aborted || cap.claudia) { rm(wav); return }
    return wav
  }

  async function turn(o: ListenOpts, cap: Capture, onSpeech?: () => void): Promise<void> {
    const wav = await capture(o, cap, onSpeech)
    if (cap.aborted) return   // whoever cancelled us already moved `state` on
    if (cap.claudia) { state = 'idle'; cur = undefined; return }   // `armed` untouched: her speech ending may open a follow-up
    try {
      if (!wav) { armed = false; log(state === 'followup' ? 'follow-up closed (silence)' : '(nothing heard)'); return }
      const text = await transcribe(cfg, wav)
      if (!text || /^[\[(].*[\])]$/.test(text)) { log('(nothing heard)'); return }
      log(`heard: ${text}`)
      markSpoken()
      onText(text)
      armFollowUp()
    } catch (e) { log(`transcription failed: ${e}`) }
    finally { if (wav) rm(wav); state = 'idle'; cur = undefined }
  }

  async function onDetect(line: string): Promise<void> {
    if (state === 'listening') return          // already recording the user
    // The model was trained on the very piper voice Claudia speaks with and fires on her own
    // sentences (0.99, live 2026-09-13). Barge-in by voice is therefore opt-in; the key still interrupts.
    if (cfg.TALK_WAKE_BARGEIN !== 'on' && alive(SAY_PID)) { log(`wake word ignored while speaking (${line})`); return }
    if (cur) cur.aborted = true                // a follow-up window was open: this is a fresh turn instead
    state = 'listening'
    const cap = cur = { aborted: false }
    log(`wake word heard (${line})`)
    uiListening('wake')
    try { const pid = Number(readFileSync(SAY_PID, 'utf8')); if (pid > 0) process.kill(pid, 'SIGTERM') } catch {}   // stop talking, the user is
    try { await Bun.spawn(splitCmd(cfg.TALK_PLAYER, { rate: String(rate) }), { stdin: new Blob([tone]), stdout: 'ignore', stderr: 'ignore' }).exited } catch (e) { log(`beep failed: ${e}`) }
    log('listening…')
    await turn({ silenceMs, speechWithinMs: CAP_MS, capMs: CAP_MS }, cap)
  }

  async function followUp(): Promise<void> {
    state = 'followup'
    const cap = cur = { aborted: false }
    log(`follow-up window ${followupMs / 1000} s — speak without the wake word`)
    await turn({ silenceMs, speechWithinMs: followupMs, capMs: CAP_MS }, cap, () => { state = 'listening'; log('follow-up: recording…') })
  }

  cancelCurrent = () => { if (state === 'followup' && cur) { cur.aborted = true; state = 'idle'; log('follow-up closed: hold key') } }

  // Claudia's speech = say.pid alive. Its end (after a spoken turn) opens the window; a new start closes it.
  let speaking = alive(SAY_PID)
  setInterval(() => {
    const now = alive(SAY_PID)
    if (now === speaking) return
    speaking = now
    if (now && state === 'followup' && cur) { cur.aborted = true; state = 'idle'; log('follow-up closed: Claudia is speaking') }
    if (!now && state === 'idle' && armed) void followUp()
  }, SAY_POLL_MS)

  function spawnDetector(): void {
    const t0 = Date.now()
    const model = modelArg(cfg.TALK_WAKE_MODEL)
    det = Bun.spawn([DETECTOR, '--model', model, '--threshold', cfg.TALK_WAKE_THRESHOLD], { stdin: 'ignore', stdout: 'pipe', stderr: openSync(LOG_FILE, 'a') })
    log(`wake word: starting detector (model ${model}, threshold ${cfg.TALK_WAKE_THRESHOLD})`)
    void readLines(det.stdout as ReadableStream<Uint8Array>, line => {
      if (line === 'ready') log(`say "${cfg.TALK_WAKE_WORD}" to talk`)
      else if (/^\S+ [\d.]+$/.test(line)) void onDetect(line)
      else log(`detector: ${line}`)
    })
    void det.exited.then(code => {
      if (exiting) return
      if (Date.now() - t0 < RESTART_AFTER_MS) { log(`wake word off: detector exited (${code}) — see ${LOG_FILE}`); return }
      log(`detector exited (${code}) after running a while; restarting`)
      spawnDetector()
    })
  }
  process.on('exit', () => { exiting = true; det?.kill(); rec?.kill() })
  spawnDetector()
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  let rest = ''
  for await (const chunk of stream) {
    const parts = (rest + new TextDecoder().decode(chunk)).split('\n')
    rest = parts.pop()!
    for (const l of parts) if (l.trim()) onLine(l.trim())
  }
}
