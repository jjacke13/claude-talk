// Pure helpers for claude-talk: config parsing, speech sanitizing, speak decision, inbox order.
// No env, no process, no MCP — everything here is unit-tested in talk.test.ts.

export const CHANNEL_TAG = '<channel source="plugin:talk:talk"'

export const DEFAULTS = {
  TALK_LANG: 'en',
  TALK_MODEL: '~/.hermes/models/ggml-base.en.bin',
  TALK_VOICE: '~/.hermes/models/piper/en_GB-alan-medium.onnx',
  TALK_SPEAK: 'mirror',
  TALK_PLAYER: 'pw-play',
  TALK_MAX_SPEAK_CHARS: '1200',
} as const
export type ConfigKey = keyof typeof DEFAULTS
export type Config = Record<ConfigKey, string>

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
export function resolveConfig(fileText: string, env: Record<string, string | undefined>, home: string): Config {
  const file = parseConfig(fileText)
  const cfg = { ...DEFAULTS } as Config
  for (const k of Object.keys(DEFAULTS) as ConfigKey[]) {
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
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')        // headings
    .replace(/^\s*>\s?/gm, '')                 // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '')             // bullets
    .replace(/^\s*\d+\.\s+/gm, '')             // numbered lists
    .replace(/(\*\*|__|\*|_|~~)/g, '')         // emphasis markers
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

// mirror: speak only when the turn was spoken (last user entry carries the talk channel tag).
export function shouldSpeak(mode: string, lastUserText: string): boolean {
  if (mode === 'on') return true
  if (mode === 'mirror') return lastUserText.includes(CHANNEL_TAG)
  return false
}

// Startup sweep order: numeric (epoch-ms) filenames ascending; non-.txt ignored.
export function sortInbox(names: string[]): string[] {
  return names.filter(n => n.endsWith('.txt')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

// Last `user` entry's text from a Claude Code transcript (JSONL). Tool results don't count.
export function lastUserText(jsonl: string): string {
  let last = ''
  for (const line of jsonl.split('\n')) {
    if (!line.startsWith('{')) continue
    let e: any
    try { e = JSON.parse(line) } catch { continue }
    if (e?.type !== 'user') continue
    const c = e.message?.content
    if (typeof c === 'string') last = c
    else if (Array.isArray(c)) {
      const texts = c.filter((p: any) => p?.type === 'text').map((p: any) => p.text)
      if (texts.length) last = texts.join('\n')
    }
  }
  return last
}
