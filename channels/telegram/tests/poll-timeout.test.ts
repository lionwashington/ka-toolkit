// e2e for the getUpdates inbound hard-timeout fix (telegram-platform.ts pollLoop).
//
// Reproduces the real 9-minute inbound outage: a half-dead TCP socket — the mock
// accepts the getUpdates request but NEVER responds. Telegram's server-side
// long-poll `timeout` does nothing here (the reply never reaches us), so without a
// CLIENT-side hard timeout the single-threaded pollLoop hangs until the OS TCP
// timeout (the observed ~9 min). With the fix it aborts after poll_hard_timeout_ms
// and reconnects on the next iteration.
//
// Proof = mock.getUpdatesCount(): a reconnect is a brand-new getUpdates request.
//   · FIX  (hard timeout on)  → count climbs while hung  (abort → reconnect loop)
//   · CTRL (hard timeout off) → count frozen at the first request (stuck forever)
//
// Fully isolated: mock Telegram on loopback + daemon in a temp data dir pointed at
// it via TELEGRAM_API_ROOT. Touches no real Telegram / daemon / workshop.
// Run: node --experimental-strip-types --test tests/poll-timeout.test.ts
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startMockTelegram, startDaemon } from './harness.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('getUpdates inbound hard-timeout (half-dead socket)', () => {
  test('FIX: hung getUpdates → aborts after hard timeout and reconnects (count climbs)', async () => {
    const mock = await startMockTelegram()
    mock.setHang(true) // half-dead socket: getUpdates accepted but never answered
    const daemon = await startDaemon({ apiRoot: mock.url, pollTimeout: 1, pollHardTimeoutMs: 2000 })
    try {
      await sleep(1500)
      const early = mock.getUpdatesCount() // first request issued, now hanging
      await sleep(13000)                   // ~2.5 abort+reconnect cycles (2s hard cap + 3s backoff)
      const later = mock.getUpdatesCount()
      assert.ok(later >= early + 2,
        `fixed daemon must keep reconnecting while hung — getUpdates count ${early} → ${later}`)

      // Recovery: socket comes back → loop resumes; an actual update gets delivered.
      mock.setHang(false)
      const beforeRecover = mock.getUpdatesCount()
      await sleep(6000)  // cover an in-flight backoff (≤3s) + a couple of normal polls
      assert.ok(mock.getUpdatesCount() > beforeRecover,
        'daemon must resume polling once the socket recovers')
    } finally {
      await daemon.stop(); await mock.close()
    }
  })

  test('CONTROL (hard timeout disabled = old behavior): hung getUpdates → stuck, count frozen', async () => {
    const mock = await startMockTelegram()
    mock.setHang(true)
    // pollHardTimeoutMs: 0 disables the client-side abort → reproduces the pre-fix hang.
    const daemon = await startDaemon({ apiRoot: mock.url, pollTimeout: 1, pollHardTimeoutMs: 0 })
    try {
      await sleep(1500)
      const c1 = mock.getUpdatesCount()
      await sleep(9000)
      const c2 = mock.getUpdatesCount()
      assert.equal(c2, c1,
        `without the fix the loop hangs on the dead socket — count must NOT advance (${c1} → ${c2})`)
      assert.ok(c1 >= 1 && c1 <= 2,
        `should be stuck on the very first hung request, got ${c1}`)
    } finally {
      await daemon.stop(); await mock.close()
    }
  })
})
