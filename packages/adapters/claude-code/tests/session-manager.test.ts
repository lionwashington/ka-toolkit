import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'

const SESSIONS_DIR = join(homedir(), '.knowledge-assistant', 'state', 'sessions')
const SESSION_MANAGER = new URL('../scripts/session-manager.mjs', import.meta.url).pathname

function uniqueSessionId(): string {
  return `test-session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function sessionFilePath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.json`)
}

function writeTestSession(sessionId: string, overrides: Record<string, unknown> = {}): void {
  const data = {
    sessionId,
    cmdline: 'claude --dangerously-skip-permissions',
    cwd: '/tmp/test-project',
    tool: 'claude-code',
    platform: 'macos',
    restart: false,
    savedAt: new Date().toISOString(),
    ...overrides,
  }
  writeFileSync(sessionFilePath(sessionId), JSON.stringify(data, null, 2), 'utf-8')
}

function runCmd(args: string): string {
  return execSync(`node ${SESSION_MANAGER} ${args}`, { encoding: 'utf-8' })
}

function runCmdUnsafe(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${SESSION_MANAGER} ${args} 2>/dev/null`, { encoding: 'utf-8' })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.status ?? 1,
    }
  }
}

describe('session-manager CLI', () => {
  let sessionId: string

  beforeAll(() => {
    mkdirSync(SESSIONS_DIR, { recursive: true })
  })

  beforeEach(() => {
    sessionId = uniqueSessionId()
    writeTestSession(sessionId)
  })

  afterEach(() => {
    const p = sessionFilePath(sessionId)
    if (existsSync(p)) rmSync(p)
  })

  // ─── get ─────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns session JSON for a known session', () => {
      const output = runCmd(`get ${sessionId}`)
      const parsed = JSON.parse(output)
      expect(parsed.sessionId).toBe(sessionId)
      expect(parsed.tool).toBe('claude-code')
      expect(parsed.restart).toBe(false)
    })

    it('exits with code 1 for an unknown session', () => {
      const result = runCmdUnsafe('get non-existent-session-id-xyz')
      expect(result.exitCode).toBe(1)
    })

    it('includes cwd and cmdline fields', () => {
      const output = runCmd(`get ${sessionId}`)
      const parsed = JSON.parse(output)
      expect(parsed.cwd).toBe('/tmp/test-project')
      expect(parsed.cmdline).toBe('claude --dangerously-skip-permissions')
    })
  })

  // ─── restart ─────────────────────────────────────────────────────────────

  describe('restart', () => {
    it('sets restart flag to true', () => {
      const before = JSON.parse(readFileSync(sessionFilePath(sessionId), 'utf-8'))
      expect(before.restart).toBe(false)

      runCmd(`restart ${sessionId}`)

      const after = JSON.parse(readFileSync(sessionFilePath(sessionId), 'utf-8'))
      expect(after.restart).toBe(true)
    })

    it('sets restartRequestedAt timestamp', () => {
      runCmd(`restart ${sessionId}`)
      const data = JSON.parse(readFileSync(sessionFilePath(sessionId), 'utf-8'))
      expect(data.restartRequestedAt).toBeDefined()
      expect(new Date(data.restartRequestedAt).getTime()).not.toBeNaN()
    })

    it('prints confirmation message', () => {
      const output = runCmd(`restart ${sessionId}`)
      expect(output).toContain('Restart flag set')
    })

    it('exits with code 1 for an unknown session', () => {
      const result = runCmdUnsafe('restart non-existent-session-id-xyz')
      expect(result.exitCode).toBe(1)
    })
  })

  // ─── clear ───────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('clears restart flag after it was set', () => {
      // Set restart first
      runCmd(`restart ${sessionId}`)
      const mid = JSON.parse(readFileSync(sessionFilePath(sessionId), 'utf-8'))
      expect(mid.restart).toBe(true)

      // Then clear it
      runCmd(`clear ${sessionId}`)

      const after = JSON.parse(readFileSync(sessionFilePath(sessionId), 'utf-8'))
      expect(after.restart).toBe(false)
    })

    it('prints confirmation message', () => {
      const output = runCmd(`clear ${sessionId}`)
      expect(output).toContain('Restart flag cleared')
    })

    it('does not error when session does not exist', () => {
      // clear is a no-op for missing sessions; should exit 0
      const result = runCmdUnsafe('clear non-existent-session-id-xyz')
      expect(result.exitCode).toBe(0)
    })

    it('preserves other session fields after clear', () => {
      runCmd(`restart ${sessionId}`)
      runCmd(`clear ${sessionId}`)
      const data = JSON.parse(readFileSync(sessionFilePath(sessionId), 'utf-8'))
      expect(data.sessionId).toBe(sessionId)
      expect(data.cwd).toBe('/tmp/test-project')
      expect(data.tool).toBe('claude-code')
    })
  })

  // ─── status ──────────────────────────────────────────────────────────────

  describe('status', () => {
    it('lists the test session', () => {
      const output = runCmd('status')
      expect(output).toContain(sessionId)
    })

    it('shows OK marker for sessions with restart=false', () => {
      const output = runCmd('status')
      expect(output).toContain('OK')
    })

    it('shows RESTART marker for sessions with restart=true', () => {
      runCmd(`restart ${sessionId}`)
      const output = runCmd('status')
      expect(output).toContain('RESTART')
    })

    it('shows cwd in output', () => {
      const output = runCmd('status')
      expect(output).toContain('/tmp/test-project')
    })
  })

  // ─── restart + clear round-trip ──────────────────────────────────────────

  describe('restart/clear round-trip', () => {
    it('toggles restart flag on and off', () => {
      runCmd(`restart ${sessionId}`)
      let data = JSON.parse(readFileSync(sessionFilePath(sessionId), 'utf-8'))
      expect(data.restart).toBe(true)

      runCmd(`clear ${sessionId}`)
      data = JSON.parse(readFileSync(sessionFilePath(sessionId), 'utf-8'))
      expect(data.restart).toBe(false)

      runCmd(`restart ${sessionId}`)
      data = JSON.parse(readFileSync(sessionFilePath(sessionId), 'utf-8'))
      expect(data.restart).toBe(true)
    })
  })

  // ─── unknown command ─────────────────────────────────────────────────────

  describe('unknown command', () => {
    it('exits with code 1 for an unknown command', () => {
      const result = runCmdUnsafe('bogus-command')
      expect(result.exitCode).toBe(1)
    })
  })
})
