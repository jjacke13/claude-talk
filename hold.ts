// Hold-to-talk: read keyboards at the evdev level, record while TALK_KEY is held, transcribe
// on release, hand the text to `onText`. Lives inside the MCP server so enabling the plugin
// is all the user does. Needs the user in the `input` group; otherwise logs once and gives up.
import { createReadStream, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE_DIR, log, markSpoken, startRecording, transcribe, type Config } from './voice.ts'

export const KEYS: Record<string, number> = {
  KEY_RIGHTALT: 100, KEY_LEFTALT: 56, KEY_RIGHTCTRL: 97, KEY_LEFTCTRL: 29, KEY_RIGHTMETA: 126,
  KEY_LEFTMETA: 125, KEY_CAPSLOCK: 58, KEY_SCROLLLOCK: 70, KEY_PAUSE: 119, KEY_MENU: 139,
  KEY_F9: 67, KEY_F10: 68, KEY_F11: 87, KEY_F12: 88,
}
const EV_KEY = 1, PRESS = 1, RELEASE = 0, MIN_HOLD_MS = 300
const LOCK = join(STATE_DIR, 'hold.lock')

export function keyboardDevices(): string[] {
  try {
    return readdirSync('/dev/input')
      .filter(n => n.startsWith('event'))
      .filter(n => { try { return /keyboard|kbd/i.test(readFileSync(`/sys/class/input/${n}/device/name`, 'utf8')) } catch { return false } })
      .map(n => `/dev/input/${n}`)
  } catch { return [] }
}

// Only one server per machine may own the key (two sessions would both answer).
function takeLock(): boolean {
  try {
    const pid = Number(readFileSync(LOCK, 'utf8'))
    if (pid && pid !== process.pid) { try { process.kill(pid, 0); return false } catch {} }   // alive → not ours
  } catch {}
  writeFileSync(LOCK, String(process.pid))
  return true
}

export function startHold(cfg: Config, onText: (text: string) => void, devices = keyboardDevices()): void {
  const keyName = cfg.TALK_KEY
  const keyCode = KEYS[keyName] ?? Number(keyName)
  if (!Number.isInteger(keyCode)) { log(`TALK_KEY "${keyName}" unknown — hold-to-talk off`); return }
  if (!devices.length) { log('hold-to-talk off: no keyboard under /dev/input'); return }
  if (!takeLock()) { log('hold-to-talk off: another talk server owns the key'); return }

  let rec: ReturnType<typeof startRecording> | undefined
  let wav = '', t0 = 0, busy = false
  async function onKey(value: number): Promise<void> {
    if (value === PRESS && !rec && !busy) {
      wav = join(tmpdir(), `talk-hold-${process.pid}.wav`)
      rec = startRecording(wav); t0 = Date.now()
      log('recording… (release to send)')
      return
    }
    if (value === RELEASE && rec) {
      const r = rec; rec = undefined; busy = true
      r.kill('SIGINT'); await r.exited
      try {
        if (Date.now() - t0 < MIN_HOLD_MS) return
        const text = await transcribe(cfg, wav)
        if (!text || /^\[.*\]$/.test(text)) { log('(nothing heard)'); return }
        log(`heard: ${text}`)
        markSpoken()
        onText(text)
      } catch (e) { log(`transcription failed: ${e}`) }
      finally { try { unlinkSync(wav) } catch {}; busy = false }
    }
  }

  // struct input_event on 64-bit: u64 sec, u64 usec, u16 type, u16 code, s32 value = 24 bytes.
  let opened = 0
  for (const path of devices) {
    let rest = Buffer.alloc(0)
    const s = createReadStream(path)
    s.on('open', () => { if (++opened === 1) log(`hold ${keyName} to talk`) })
    s.on('data', (chunk: Buffer) => {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk
      let off = 0
      for (; off + 24 <= buf.length; off += 24) {
        if (buf.readUInt16LE(off + 16) === EV_KEY && buf.readUInt16LE(off + 18) === keyCode) void onKey(buf.readInt32LE(off + 20))
      }
      rest = buf.subarray(off)
    })
    s.on('error', e => log(`hold-to-talk off for ${path}: ${(e as Error).message} — add your user to the \`input\` group`))
  }
}
