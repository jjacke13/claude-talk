import { expect, test } from 'bun:test'
import { pushEvent, reduceState, sseFrame, type UiEvent } from './ui.ts'

test('pushEvent: appends immutably and keeps the last N', () => {
  const a: UiEvent[] = []
  const b = pushEvent(a, { type: 'user', text: 'one', ts: 1 }, 2)
  const c = pushEvent(b, { type: 'assistant', text: 'two', ts: 2 }, 2)
  const d = pushEvent(c, { type: 'user', text: 'three', ts: 3 }, 2)
  expect(a).toEqual([])
  expect(b.length).toBe(1)
  expect(d.map(e => (e as any).text)).toEqual(['two', 'three'])
})

test('sseFrame: one data line, JSON, blank-line terminated', () => {
  expect(sseFrame({ type: 'state', state: 'idle' })).toBe('data: {"type":"state","state":"idle"}\n\n')
  expect(sseFrame({ type: 'user', text: 'a\nb', ts: 5 })).toBe('data: {"type":"user","text":"a\\nb","ts":5}\n\n')
})

test('reduceState: press/wake → listening, user → thinking, speaking, silence ends speaking only', () => {
  expect(reduceState('idle', 'press')).toBe('listening')
  expect(reduceState('speaking', 'wake')).toBe('listening')
  expect(reduceState('listening', 'user')).toBe('thinking')
  expect(reduceState('thinking', 'speaking')).toBe('speaking')
  expect(reduceState('speaking', 'silent')).toBe('idle')
  expect(reduceState('thinking', 'silent')).toBe('thinking')     // still waiting for the answer
  expect(reduceState('listening', 'silent')).toBe('listening')
  expect(reduceState('thinking', 'timeout')).toBe('idle')        // answer came as text only
  expect(reduceState('listening', 'timeout')).toBe('idle')       // key released with nothing heard
  expect(reduceState('speaking', 'timeout')).toBe('speaking')    // timeouts never cut real speech
})

test('wake/ui defaults present', async () => {
  const { resolveConfig } = await import('./talk.ts')
  const c = resolveConfig('', {}, '/h')
  expect(c.TALK_UI).toBe('off')
  expect(c.TALK_UI_PORT).toBe('7590')
})
