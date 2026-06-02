#!/usr/bin/env node
/**
 * Session Manager for Claude Code auto-restart
 *
 * Commands:
 *   save <session_id>    — Capture current claude process args/cwd, save by session_id
 *   restart <session_id> — Set restart flag for a session
 *   clear <session_id>   — Clear restart flag
 *   status               — Show all saved sessions
 *   get <session_id>     — Get session info as JSON
 *
 * Storage: ~/.knowledge-assistant/state/sessions/<session_id>.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'

const SESSIONS_DIR = join(homedir(), '.knowledge-assistant', 'state', 'sessions')
mkdirSync(SESSIONS_DIR, { recursive: true })

function sessionPath(sessionId) {
  return join(SESSIONS_DIR, `${sessionId}.json`)
}

function readSession(sessionId) {
  const p = sessionPath(sessionId)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null }
}

function writeSession(sessionId, data) {
  writeFileSync(sessionPath(sessionId), JSON.stringify(data, null, 2), 'utf-8')
}

function detectPlatform() {
  const p = process.platform
  if (p === 'darwin') return 'macos'
  if (p === 'win32') return 'windows'
  return 'linux'
}

function validateSessionId(id) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid session ID: ${id}`)
  }
  return id
}

function findClaudeProcess(sessionId) {
  const safeId = validateSessionId(sessionId)
  const platform = detectPlatform()
  try {
    if (platform === 'windows') {
      const out = execSync('wmic process where "name like \'%claude%\'" get ProcessId,CommandLine /format:csv', { encoding: 'utf-8' })
      const lines = out.trim().split('\n').filter(l => l.includes(safeId))
      if (lines.length === 0) return null
      const parts = lines[0].split(',')
      return { pid: parts[parts.length - 1].trim(), cmdline: parts.slice(1, -1).join(',').trim() }
    } else {
      // macOS / Linux
      const out = execSync(`ps aux | grep '[c]laude' | grep '${safeId}'`, { encoding: 'utf-8' }).trim()
      if (!out) return null
      const firstLine = out.split('\n')[0]
      const parts = firstLine.split(/\s+/)
      const pid = parts[1]
      // Extract cmdline: everything after the 10th field
      const cmdline = parts.slice(10).join(' ')

      // Get working directory
      let cwd = ''
      if (!/^\d+$/.test(pid)) return null
      if (platform === 'macos') {
        const lsofOut = execSync(`lsof -p ${pid} 2>/dev/null | grep cwd`, { encoding: 'utf-8' }).trim()
        cwd = lsofOut.split(/\s+/).pop() || ''
      } else {
        // Linux
        try { cwd = readFileSync(`/proc/${pid}/cwd`, 'utf-8').trim() } catch {
          cwd = execSync(`readlink /proc/${pid}/cwd 2>/dev/null`, { encoding: 'utf-8' }).trim()
        }
      }
      return { pid, cmdline, cwd }
    }
  } catch {
    return null
  }
}

function cmdSave(sessionId) {
  let proc = findClaudeProcess(sessionId)
  if (!proc) {
    // Fallback: try to find any claude process with --resume
    const fallback = findClaudeProcessByResume()
    if (!fallback) {
      console.error(`[session-manager] No claude process found for session ${sessionId}`)
      process.exit(1)
    }
    proc = fallback
  }

  const data = {
    sessionId,
    cmdline: proc.cmdline,
    cwd: proc.cwd,
    tool: 'claude-code',
    platform: detectPlatform(),
    restart: false,
    savedAt: new Date().toISOString(),
  }
  writeSession(sessionId, data)
  console.log(`[session-manager] Saved session ${sessionId}`)
  console.log(`  cwd: ${data.cwd}`)
  console.log(`  cmd: ${data.cmdline}`)
}

function findClaudeProcessByResume() {
  try {
    const platform = detectPlatform()
    if (platform === 'windows') return null
    const out = execSync("ps aux | grep '[c]laude --dangerously' | grep -v stream-json", { encoding: 'utf-8' }).trim()
    if (!out) return null
    const firstLine = out.split('\n')[0]
    const parts = firstLine.split(/\s+/)
    const pid = parts[1]
    const cmdline = parts.slice(10).join(' ')
    let cwd = ''
    if (platform === 'macos') {
      const lsofOut = execSync(`lsof -p ${pid} 2>/dev/null | grep cwd`, { encoding: 'utf-8' }).trim()
      cwd = lsofOut.split(/\s+/).pop() || ''
    } else {
      cwd = execSync(`readlink /proc/${pid}/cwd 2>/dev/null`, { encoding: 'utf-8' }).trim()
    }
    return { pid, cmdline, cwd }
  } catch {
    return null
  }
}

function cmdRestart(sessionId) {
  const session = readSession(sessionId)
  if (!session) {
    console.error(`[session-manager] No saved session found for ${sessionId}`)
    process.exit(1)
  }
  session.restart = true
  session.restartRequestedAt = new Date().toISOString()
  writeSession(sessionId, session)
  console.log(`[session-manager] Restart flag set for ${sessionId}`)
}

function cmdClear(sessionId) {
  const session = readSession(sessionId)
  if (!session) return
  session.restart = false
  writeSession(sessionId, session)
  console.log(`[session-manager] Restart flag cleared for ${sessionId}`)
}

function cmdStatus() {
  if (!existsSync(SESSIONS_DIR)) {
    console.log('No sessions saved.')
    return
  }
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
  if (files.length === 0) {
    console.log('No sessions saved.')
    return
  }
  for (const f of files) {
    const data = readSession(f.replace('.json', ''))
    if (!data) continue
    const flag = data.restart ? '🔄 RESTART' : '✅ OK'
    console.log(`${flag} ${data.sessionId}`)
    console.log(`   cwd: ${data.cwd}`)
    console.log(`   cmd: ${data.cmdline}`)
    console.log(`   saved: ${data.savedAt}`)
    console.log()
  }
}

function cmdGet(sessionId) {
  const session = readSession(sessionId)
  if (!session) {
    console.error(`[session-manager] No saved session for ${sessionId}`)
    process.exit(1)
  }
  console.log(JSON.stringify(session, null, 2))
}

// CLI dispatch
const [,, command, arg] = process.argv

switch (command) {
  case 'save':
    if (!arg) { console.error('Usage: session-manager save <session_id>'); process.exit(1) }
    cmdSave(arg)
    break
  case 'restart':
    if (!arg) { console.error('Usage: session-manager restart <session_id>'); process.exit(1) }
    cmdRestart(arg)
    break
  case 'clear':
    if (!arg) { console.error('Usage: session-manager clear <session_id>'); process.exit(1) }
    cmdClear(arg)
    break
  case 'status':
    cmdStatus()
    break
  case 'get':
    if (!arg) { console.error('Usage: session-manager get <session_id>'); process.exit(1) }
    cmdGet(arg)
    break
  default:
    console.log('Usage: session-manager <save|restart|clear|status|get> [session_id]')
    process.exit(1)
}
