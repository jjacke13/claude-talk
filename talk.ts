// Pure helpers for claude-talk: config parsing, speech sanitizing, speak decision, inbox order.
// No env, no process, no MCP — everything here is unit-tested in talk.test.ts.

// Player and recorder are argv templates (whitespace-split, no shell). Placeholders: {rate} = the
// voice sample rate (player gets raw s16le mono on stdin), {raw} = output path for raw s16le 16 kHz
// mono (we add the WAV header ourselves, so killing the recorder mid-stream is always safe).
export const AUDIO_DEFAULTS: Record<string, { TALK_PLAYER: string; TALK_RECORDER: string }> = {
  linux: {
    TALK_PLAYER: 'pw-play --raw --rate {rate} --channels 1 --format s16 -',
    TALK_RECORDER: 'pw-record --raw --rate 16000 --channels 1 --format s16 {raw}',
  },
  // SoX is the cross-platform fallback (default device on Windows/macOS). UNTESTED on Windows.
  other: {
    TALK_PLAYER: 'play -q -t raw -r {rate} -e signed -b 16 -c 1 -',
    TALK_RECORDER: 'rec -q -t raw -r 16000 -e signed -b 16 -c 1 {raw}',
  },
}
export function defaultsFor(platform: string) {
  return {
    TALK_LANG: 'en',
    TALK_MODEL: '~/.hermes/models/ggml-base.en.bin',
    TALK_VOICE: '~/.hermes/models/piper/en_GB-alan-medium.onnx',
    TALK_SPEAK: 'mirror',
    TALK_MAX_SPEAK_CHARS: '1200',
    TALK_KEY: 'KEY_RIGHTALT',
    TALK_SPEED: '1.0',
    ...(AUDIO_DEFAULTS[platform] ?? AUDIO_DEFAULTS.other!),
  }
}
export const DEFAULTS = defaultsFor('linux')
export type ConfigKey = keyof typeof DEFAULTS
export type Config = Record<ConfigKey, string>

// Expand an argv template: whitespace split, {name} substitution. No shell, no quoting rules.
export function splitCmd(template: string, vars: Record<string, string>): string[] {
  return template.trim().split(/\s+/).map(a => a.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''))
}

// KEY=value lines. Blank and #-comment lines ignored; optional `export `; quoted values
// verbatim; unquoted values lose a trailing whitespace-preceded `# comment`. Last key wins.
export function parseConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const q = m[2]!.match(/^(["'])(.*)\1(?:\s+#.*)?$/)
    out[m[1]!] = q ? q[2]! : m[2]!.replace(/\s+#.*$/, '')
  }
  return out
}

// Defaults ← config file ← real environment (env wins). `~/` expanded with `home`.
export function resolveConfig(fileText: string, env: Record<string, string | undefined>, home: string, platform = 'linux'): Config {
  const file = parseConfig(fileText)
  const cfg = defaultsFor(platform) as Config
  for (const k of Object.keys(cfg) as ConfigKey[]) {
    const v = env[k] ?? file[k]
    if (v !== undefined && v !== '') cfg[k] = v
    cfg[k] = cfg[k].replace(/^~(?=\/|$)/, home)
  }
  return cfg
}

// Markdown → something a TTS voice can read. Code is dropped, not read aloud.
export function sanitizeForSpeech(md: string, maxChars = 1200): string {
  let t = md
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code blocks
    .replace(/`[^`\n]*`/g, ' ')                // inline code
    .replace(/^\s*\|.*\|\s*$/gm, ' ')          // table rows
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')     // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // links → label
    .replace(/^\s*>\s?/gm, '')                 // blockquotes (before headings: "> # T")
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')        // headings
    .replace(/^\s*[-*+]\s+/gm, '')             // bullets
    .replace(/^\s*\d+\.\s+/gm, '')             // numbered lists
    .replace(/(\*\*|__|~~|\*)/g, '')            // emphasis markers
    .replace(/(?<!\w)_|_(?!\w)/g, '')             // _emphasis_ but not snake_case
    .replace(/~(?=\/|\s|$)/g, '')                 // lone ~ (paths)
    .replace(/https?:\/\/\S+/g, 'link')        // bare URLs
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    t = (end > maxChars / 2 ? cut.slice(0, end + 1) : cut).trim()
  }
  return t
}

// mirror: speak only when the turn was spoken (bin/talk left its marker).
export function shouldSpeak(mode: string, spoken: boolean): boolean {
  if (mode === 'on') return true
  if (mode === 'mirror') return spoken
  return false
}

// Startup sweep order: numeric (epoch-ms) filenames ascending; non-.txt ignored.
export function sortInbox(names: string[]): string[] {
  return names.filter(n => n.endsWith('.txt')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

