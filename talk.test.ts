import { expect, test } from 'bun:test'
import { parseConfig, resolveConfig, sanitizeForSpeech, shouldSpeak, sortInbox, splitCmd } from './talk.ts'

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
  expect(sanitizeForSpeech(md)).toBe('Title Done. Run now. bold item see docs quote More at link ok.')
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
