import { expect, test } from 'bun:test'
import { modelArg } from './wake.ts'
import { parseDetection, parseWakeExtra, parseWav, resolveConfig, thresholdFor, wakeAction, wakeKey } from './talk.ts'

test('modelArg: bare name → shipped models/<name>.onnx; prebuilt names and paths pass through', () => {
  expect(modelArg('hey_claudia')).toMatch(/\/models\/hey_claudia\.onnx$/)
  expect(modelArg('hey_jarvis')).toBe('hey_jarvis')
  expect(modelArg('/tmp/x/custom.onnx')).toBe('/tmp/x/custom.onnx')
  expect(modelArg('models/other.onnx')).toBe('models/other.onnx')
})

test('parseWakeExtra: name=kind:arg pairs, ~ expanded, bad entries reported', () => {
  const { extras, errors } = parseWakeExtra(' hey_michael=sound:~/s/hee.wav , bad, x=session:http://h/u, models/y.onnx=sound:/a.wav,hey_michael=sound:/b.wav', '/home/u')
  expect(extras).toEqual([
    { name: 'hey_michael', action: { kind: 'sound', arg: '/home/u/s/hee.wav' } },
    { name: 'models/y.onnx', action: { kind: 'sound', arg: '/a.wav' } },
  ])
  expect(errors).toHaveLength(3)   // no '=', unknown kind (session: not yet), duplicate name
  expect(errors[1]).toContain('x=session:http://h/u')
  expect(parseWakeExtra('', '/h')).toEqual({ extras: [], errors: [] })
  expect(resolveConfig('', {}, '/h').TALK_WAKE_EXTRA).toBe('')
})

test('wakeAction: dispatch by detector key; unknown key = main word', () => {
  const { extras } = parseWakeExtra('hey_michael=sound:/a.wav,/m/robot.onnx=sound:/b.wav,alexa=sound:/c.wav', '/h')
  expect(wakeAction('hey_michael', extras)?.action.arg).toBe('/a.wav')
  expect(wakeAction('robot', extras)?.action.arg).toBe('/b.wav')
  expect(wakeAction('alexa_v0.1', extras)?.action.arg).toBe('/c.wav')     // prebuilt keys carry a version
  expect(wakeAction('hey_claudia', extras)).toBeUndefined()
  expect(wakeAction('hey_michaelx', extras)).toBeUndefined()
  expect(wakeKey('/x/models/hey_michael.onnx')).toBe('hey_michael')
})

test('parseDetection: "<model> <score>" only', () => {
  expect(parseDetection('hey_michael 0.913')).toEqual({ model: 'hey_michael', score: 0.913 })
  expect(parseDetection('hey_jarvis_v0.1 1')).toEqual({ model: 'hey_jarvis_v0.1', score: 1 })
  expect(parseDetection('ready')).toBeNull()
  expect(parseDetection('WARNING something 0.5 happened')).toBeNull()
})

test('thresholdFor: TALK_WAKE_THRESHOLD_<NAME>, invalid → default', () => {
  expect(thresholdFor('hey_michael', { TALK_WAKE_THRESHOLD_HEY_MICHAEL: '0.7' }, '0.5')).toBe('0.7')
  expect(thresholdFor('/m/hey-robot.onnx', { TALK_WAKE_THRESHOLD_HEY_ROBOT: '0.6' }, '0.5')).toBe('0.6')
  expect(thresholdFor('hey_michael', { TALK_WAKE_THRESHOLD_HEY_MICHAEL: '7' }, '0.5')).toBe('0.5')
  expect(thresholdFor('hey_michael', {}, '0.85')).toBe('0.85')
})

test('parseWav: mono passes through, stereo → first channel, non-PCM16 refused', () => {
  const wav = (ch: number, bits: number, data: Buffer, extra = Buffer.alloc(0)) => {
    const h = Buffer.alloc(36); h.write('RIFF', 0); h.writeUInt32LE(28 + extra.length + data.length, 4); h.write('WAVE', 8)
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(22050, 24)
    h.writeUInt32LE(22050 * ch * bits / 8, 28); h.writeUInt16LE(ch * bits / 8, 32); h.writeUInt16LE(bits, 34)
    const d = Buffer.alloc(8); d.write('data', 0); d.writeUInt32LE(data.length, 4)
    return Buffer.concat([h, extra, d, data])
  }
  const mono = Buffer.from([1, 0, 2, 0, 3, 0])
  expect(parseWav(wav(1, 16, mono))).toEqual({ rate: 22050, pcm: mono })
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc\0')])   // odd chunk + pad byte
  expect(parseWav(wav(1, 16, mono, list)).pcm).toEqual(mono)
  expect(parseWav(wav(2, 16, Buffer.from([1, 0, 9, 9, 2, 0, 9, 9]))).pcm).toEqual(Buffer.from([1, 0, 2, 0]))
  expect(() => parseWav(wav(1, 8, mono))).toThrow('16-bit PCM')
  expect(() => parseWav(Buffer.from('hello world, not a wav'))).toThrow('not a WAV')
})
