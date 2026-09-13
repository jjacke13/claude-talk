import { expect, test } from 'bun:test'
import { modelArg } from './wake.ts'

test('modelArg: bare name → shipped models/<name>.onnx; prebuilt names and paths pass through', () => {
  expect(modelArg('hey_claudia')).toMatch(/\/models\/hey_claudia\.onnx$/)
  expect(modelArg('hey_jarvis')).toBe('hey_jarvis')
  expect(modelArg('/tmp/x/custom.onnx')).toBe('/tmp/x/custom.onnx')
  expect(modelArg('models/other.onnx')).toBe('models/other.onnx')
})
