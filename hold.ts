// Hold-to-talk: read keyboards at the evdev level, record while TALK_KEY is held, transcribe
// on release, hand the text to `onText`. Lives inside the MCP server so enabling the plugin
// is all the user does. Needs the user in the `input` group; otherwise logs once and gives up.
import { createReadStream, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SAY_PID, STATE_DIR, log, markSpoken, startRecording, stopRecording, transcribe, type Config } from './voice.ts'
import { readFileSync as readSync } from 'fs'

export const KEYS: Record<string, number> = {
  KEY_RIGHTALT: 100, KEY_LEFTALT: 56, KEY_RIGHTCTRL: 97, KEY_LEFTCTRL: 29, KEY_RIGHTMETA: 126,
  KEY_LEFTMETA: 125, KEY_CAPSLOCK: 58, KEY_SCROLLLOCK: 70, KEY_PAUSE: 119, KEY_MENU: 139,
  KEY_F9: 67, KEY_F10: 68, KEY_F11: 87, KEY_F12: 88,
}
// Windows virtual-key codes for the same names (GetAsyncKeyState). UNTESTED — no Windows box yet.
export const VKEYS: Record<string, number> = {
  KEY_RIGHTALT: 0xa5, KEY_LEFTALT: 0xa4, KEY_RIGHTCTRL: 0xa3, KEY_LEFTCTRL: 0xa2, KEY_RIGHTMETA: 0x5c,
  KEY_LEFTMETA: 0x5b, KEY_CAPSLOCK: 0x14, KEY_SCROLLLOCK: 0x91, KEY_PAUSE: 0x13, KEY_MENU: 0x5d,
  KEY_F9: 0x78, KEY_F10: 0x79, KEY_F11: 0x7a, KEY_F12: 0x7b,
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

export function startHold(cfg: Config, onText: (text: string) => void, devices?: string[]): void {
  const keyName = cfg.TALK_KEY
  const win = process.platform === 'win32'
  const keyCode = (win ? VKEYS[keyName] : KEYS[keyName]) ?? Number(keyName)
  if (!Number.isInteger(keyCode)) { log(`TALK_KEY "${keyName}" unknown — hold-to-talk off`); return }
  devices ??= win ? [] : keyboardDevices()
  if (!win && !devices.length) { log('hold-to-talk off: no keyboard under /dev/input'); return }
  if (!takeLock()) { log('hold-to-talk off: another talk server owns the key'); return }

  let rec: ReturnType<typeof startRecording> | undefined
  let wav = '', t0 = 0, busy = false
  async function onKey(value: number): Promise<void> {
    if (value === PRESS && !rec && !busy) {
      try { process.kill(Number(readSync(SAY_PID, 'utf8')), 'SIGTERM') } catch {}   // stop talking, the user is
      wav = join(tmpdir(), `talk-hold-${process.pid}.wav`)
      rec = startRecording(cfg, wav); t0 = Date.now()
      log('recording… (release to send)')
      return
    }
    if (value === RELEASE && rec) {
      const r = rec; rec = undefined; busy = true
      await stopRecording(r, wav)
      try {
        if (Date.now() - t0 < MIN_HOLD_MS) return
        const text = await transcribe(cfg, wav)
        if (!text || /^[\[(].*[\])]$/.test(text)) { log("(nothing heard)"); return }
        log(`heard: ${text}`)
        markSpoken()
        onText(text)
      } catch (e) { log(`transcription failed: ${e}`) }
      finally { for (const f of [wav, wav + '.raw']) try { unlinkSync(f) } catch {}; busy = false }
    }
  }

  if (win) { pollWindowsKey(keyCode, keyName, onKey); return }

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

// Windows: no evdev; poll GetAsyncKeyState every 20 ms via bun:ffi (bit 15 = currently down).
// Global like evdev, no group membership needed. UNTESTED — written before a Windows box existed.
function pollWindowsKey(vk: number, keyName: string, onKey: (value: number) => void): void {
  let user32: any
  try {
    // Dynamic import keeps Linux free of the module; bun:ffi resolves at runtime only on win32.
    const ffi = require('bun:ffi')
    user32 = ffi.dlopen('user32.dll', { GetAsyncKeyState: { args: ['int'], returns: 'i16' } }).symbols
  } catch (e) { log(`hold-to-talk off: cannot load user32.dll (${e})`); return }
  let down = false
  setInterval(() => {
    const now = (user32.GetAsyncKeyState(vk) & 0x8000) !== 0
    if (now !== down) { down = now; onKey(now ? PRESS : RELEASE) }
  }, 20)
  log(`hold ${keyName} to talk`)
}
