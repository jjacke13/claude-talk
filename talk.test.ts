import { expect, test } from 'bun:test'
import { beepPcm, listenDone, listenStart, listenStep, parseConfig, resolveConfig, rms, sanitizeForSpeech, shouldSpeak, sortInbox, splitCmd, toolNarration, turnState, turnTexts } from './talk.ts'

test('parseConfig: comments, quotes, export, last wins', () => {
  expect(parseConfig(['# c', '', 'TALK_LANG=el # greek', 'export TALK_SPEAK=on', 'TALK_VOICE="a # b"', 'TALK_LANG=fr', 'x=1'].join('\n')))
    .toEqual({ TALK_LANG: 'fr', TALK_SPEAK: 'on', TALK_VOICE: 'a # b' })
})

test('resolveConfig: defaults < file < env, ~ expanded', () => {
  const c = resolveConfig('TALK_LANG=el\nTALK_MODEL=~/m.bin\nTALK_SPEAK=', { TALK_LANG: 'de' }, '/home/u')
  expect(c.TALK_LANG).toBe('de')
  expect(c.TALK_MODEL).toBe('/home/u/m.bin')
  expect(c.TALK_SPEAK).toBe('mirror')                 // empty file value → default
  expect(c.TALK_VOICE).toBe('/home/u/.hermes/models/piper/en_GB-alan-medium.onnx')
})

test('sanitizeForSpeech: strips code/markdown, keeps prose', () => {
  const md = '# Title\n\nDone. Run `bun test` now.\n\n```ts\nconst x = 1\n```\n\n- **bold** item\n- see [docs](https://x.y/z)\n\n| a | b |\n|---|---|\n\n> quote\n\nMore at https://example.com ok.'
  expect(sanitizeForSpeech(md)).toBe('Title Done. Run bun test now. bold item see docs quote More at link ok.')
})

test('sanitizeForSpeech: cuts long text at a sentence boundary', () => {
  const s = sanitizeForSpeech(('Sentence one. ').repeat(200), 100)
  expect(s.length).toBeLessThanOrEqual(100)
  expect(s.endsWith('.')).toBe(true)
})

test('shouldSpeak modes', () => {
  expect(shouldSpeak('on', false)).toBe(true)
  expect(shouldSpeak('off', true)).toBe(false)
  expect(shouldSpeak('mirror', true)).toBe(true)
  expect(shouldSpeak('mirror', false)).toBe(false)
  expect(shouldSpeak('weird', true)).toBe(false)
})

test('sortInbox: numeric order, txt only', () => {
  expect(sortInbox(['9.txt', '10.txt', 'a.tmp', '2.txt'])).toEqual(['2.txt', '9.txt', '10.txt'])
})

test('sanitizeForSpeech: keeps snake_case, strips _emphasis_, quoted heading, lone ~', () => {
  expect(sanitizeForSpeech('Set TALK_SPEAK in my_var; this is _important_ and **bold**.')).toBe('Set TALK_SPEAK in my_var; this is important and bold.')
  expect(sanitizeForSpeech('> # Title\n\n1. first\n2. second')).toBe('Title first second')
  expect(sanitizeForSpeech('Look in ~/.hermes/models ~ ok')).toBe('Look in /.hermes/models ok')
})

test('platform audio defaults + splitCmd', () => {
  expect(resolveConfig('', {}, '/h', 'linux').TALK_RECORDER).toContain('pw-record')
  expect(resolveConfig('', {}, '/h', 'win32').TALK_PLAYER).toContain('play')
  expect(resolveConfig('TALK_PLAYER=ffplay -i pipe:0 -ar {rate}', {}, '/h', 'win32').TALK_PLAYER).toBe('ffplay -i pipe:0 -ar {rate}')
  expect(splitCmd(' pw-play  --rate {rate} {raw} - ', { rate: '22050', raw: '/t/x.raw' })).toEqual(['pw-play', '--rate', '22050', '/t/x.raw', '-'])
})

test('sanitizeForSpeech: drops Sources section and link-only lines', () => {
  const md = 'Nobody has it yet.\n\n- [repo one](https://x/a)\n- see [docs](https://x/b) for detail\n\nSources: [a2a topic](https://x/c), [mcp docs](https://x/d)'
  expect(sanitizeForSpeech(md)).toBe('Nobody has it yet. see docs for detail')
})

test('sanitizeForSpeech: owner/repo and paths read as last segment; dates untouched', () => {
  expect(sanitizeForSpeech('See jcwatson11/claude-a2a and docs/superpowers/specs on 12/09.')).toBe('See claude-a2a and specs on 12/09.')
})

test('sanitizeForSpeech: short inline code spoken as words, long dropped', () => {
  expect(sanitizeForSpeech('launch without `--plugin-dir` or run `claude plugin update talk@claude-talk` then `bun test`.')).toBe('launch without plugin dir or run then bun test.')
})

test('turnTexts: all assistant text since the last real user prompt; tool_result does not reset', () => {
  const j = (o: unknown) => JSON.stringify(o)
  const lines = [
    j({ type: 'user', message: { content: 'first' } }),
    j({ type: 'assistant', message: { content: [{ type: 'text', text: 'old' }] } }),
    j({ type: 'user', message: { content: [{ type: 'text', text: 'second' }] } }),
    j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixing this.' }, { type: 'tool_use', name: 'Bash' }] } }),
    j({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }, { type: 'text', text: 'Note: file changed on disk' }] } }),
    j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } }),
    j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }),
  ].join('\n')
  expect(turnTexts(lines)).toEqual(['Fixing this.', 'Done.'])
  expect(turnState(lines).key).toBe(2)
  expect(turnTexts('')).toEqual([])
})

test('toolNarration', () => {
  expect(toolNarration('Bash', { command: 'ls', description: 'List files' })).toBe('List files')
  expect(toolNarration('Read', { file_path: '/a/b/server.ts' })).toBe('reading server.ts')
  expect(toolNarration('Edit', { file_path: '/a/talk.ts' })).toBe('editing talk.ts')
  expect(toolNarration('Agent', { description: 'Review branch' })).toBe('dispatching an agent: Review branch')
  expect(toolNarration('Weird', {})).toBe('')
})

test('wake defaults present', () => {
  const c = resolveConfig('', {}, '/h')
  expect(c.TALK_WAKE).toBe('off')
  expect(c.TALK_WAKE_WORD).toBe('hey claudia')
  expect(c.TALK_WAKE_MODEL).toBe('hey_claudia')
  expect([c.TALK_WAKE_THRESHOLD, c.TALK_WAKE_FOLLOWUP_S, c.TALK_WAKE_SILENCE_MS, c.TALK_WAKE_RMS]).toEqual(['0.5', '6', '1200', '0.01'])
})

test('rms: silence 0, full-scale square 1, empty 0', () => {
  expect(rms(Buffer.alloc(64))).toBe(0)
  const sq = Buffer.alloc(8); sq.writeInt16LE(-32768, 0); sq.writeInt16LE(-32768, 2); sq.writeInt16LE(-32768, 4); sq.writeInt16LE(-32768, 6)
  expect(rms(sq)).toBe(1)
  expect(rms(Buffer.alloc(0))).toBe(0)
})

test('beepPcm: right length, starts at zero, half-scale peak', () => {
  const b = beepPcm(16000, 880, 120)
  expect(b.length).toBe(16000 * 120 / 1000 * 2)
  expect(b.readInt16LE(0)).toBe(0)
  let peak = 0; for (let i = 0; i < b.length; i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i)))
  expect(peak).toBeGreaterThan(16000); expect(peak).toBeLessThanOrEqual(16384)
})

test('listenStep/listenDone: silence after speech, no speech, cap', () => {
  const o = { silenceMs: 1200, speechWithinMs: 6000, capMs: 20000 }
  let s = listenStart(0)
  expect(listenDone(s, 500, o)).toBeNull()
  expect(listenDone(s, 6000, o)).toBe('nospeech')             // window elapsed, nothing said
  s = listenStep(s, 0.05, 700, 0.01, 100)                      // a 100 ms blip: loud, but not speech yet
  expect(s.heard).toBe(0); expect(s.loud).toBe(700)
  expect(listenDone(s, 2000, o)).toBeNull()                    // so no silence countdown from it
  s = listenStep(s, 0.05, 1000, 0.01, 200)                     // 300 ms cumulative at 1 s → speech
  expect(s.heard).toBe(1000)
  s = listenStep(s, 0.001, 1500, 0.01, 100)                    // quiet chunk keeps `loud` at 1000
  expect(s.loud).toBe(1000)
  expect(listenDone(s, 2100, o)).toBeNull()                    // 1.1 s quiet: not yet
  expect(listenDone(s, 2200, o)).toBe('silence')               // 1.2 s quiet: done
  s = listenStep(s, 0.05, 19990, 0.01, 100)
  expect(listenDone(s, 20000, o)).toBe('cap')
  expect(listenDone(listenStart(0), 20000, { ...o, speechWithinMs: 30000 })).toBe('nospeech')   // cap without speech = nothing
})
