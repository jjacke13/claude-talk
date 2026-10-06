import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { takeLock } from './hold.ts'

const tmpLock = () => join(mkdtempSync(join(tmpdir(), 'talk-lock-')), 'x.lock')

test('takeLock: a live owner keeps the lock', () => {
  const lock = tmpLock()
  writeFileSync(lock, String(process.ppid))
  expect(takeLock(lock)).toBe(false)
})

test.skipIf(process.platform !== 'linux')('takeLock: a lock from before this boot is stale even if its PID is alive again', () => {
  const lock = tmpLock()
  writeFileSync(lock, String(process.ppid))
  utimesSync(lock, 1000, 1000)
  expect(takeLock(lock)).toBe(true)
  expect(readFileSync(lock, 'utf8')).toBe(String(process.pid))
})
