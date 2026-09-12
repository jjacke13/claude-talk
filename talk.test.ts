import { expect, test } from 'bun:test'
import { CHANNEL_TAG, lastUserText, parseConfig, resolveConfig, sanitizeForSpeech, shouldSpeak, sortInbox } from './talk.ts'

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
  expect(shouldSpeak('on', '')).toBe(true)
  expect(shouldSpeak('off', CHANNEL_TAG)).toBe(false)
  expect(shouldSpeak('mirror', `${CHANNEL_TAG} ts="x">hi</channel>`)).toBe(true)
  expect(shouldSpeak('mirror', 'typed prompt')).toBe(false)
  expect(shouldSpeak('weird', CHANNEL_TAG)).toBe(false)
})

test('sortInbox: numeric order, txt only', () => {
  expect(sortInbox(['9.txt', '10.txt', 'a.tmp', '2.txt'])).toEqual(['2.txt', '9.txt', '10.txt'])
})

test('lastUserText: string and array content, tool_result ignored', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'first' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: `${CHANNEL_TAG} ts="t">yo</channel>` }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
    'not json',
  ].join('\n')
  expect(lastUserText(lines)).toContain(CHANNEL_TAG)
  expect(lastUserText('')).toBe('')
})

test('sanitizeForSpeech: keeps snake_case, strips _emphasis_, quoted heading, lone ~', () => {
  expect(sanitizeForSpeech('Set TALK_SPEAK in my_var; this is _important_ and **bold**.')).toBe('Set TALK_SPEAK in my_var; this is important and bold.')
  expect(sanitizeForSpeech('> # Title\n\n1. first\n2. second')).toBe('Title first second')
  expect(sanitizeForSpeech('Look in ~/.hermes/models ~ ok')).toBe('Look in /.hermes/models ok')
})
