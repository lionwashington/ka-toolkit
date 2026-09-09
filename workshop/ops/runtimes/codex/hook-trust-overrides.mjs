#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'

// Codex 0.153.4 deliberately ignores the TUI bypass for persistent remote
// resumes. Discover exact identities through Codex, then trust only this
// invocation's enabled hooks using CLI overlays. Never write hooks.state to
// the user's configuration or reproduce Codex's hash algorithm here.
export function hookTrustOverride(response, cwd) {
  if (!Array.isArray(response?.data)) throw new Error('invalid hook discovery response')
  const entries = response.data.filter(entry => entry.cwd === cwd)
  if (entries.length !== 1) throw new Error('hook discovery workspace mismatch')
  const entry = entries[0]
  if (!Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || entry.errors.length) {
    throw new Error('hook discovery reported invalid configuration')
  }
  const hashes = new Map()
  for (const hook of entry.hooks) {
    if (hook.enabled === false || hook.isManaged === true || hook.trustStatus === 'trusted') continue
    if (hook.enabled !== true || !['untrusted', 'modified'].includes(hook.trustStatus) ||
        typeof hook.key !== 'string' || !hook.key ||
        typeof hook.currentHash !== 'string' || !hook.currentHash || /[\x00-\x1f\x7f]/u.test(hook.key + hook.currentHash)) {
      throw new Error('invalid hook trust metadata')
    }
    if (hashes.has(hook.key) && hashes.get(hook.key) !== hook.currentHash) throw new Error('conflicting hook identities')
    hashes.set(hook.key, hook.currentHash)
  }
  if (!hashes.size) return ''
  // Quoted dotted CLI paths are split literally by Codex: use an inline table
  // instead. The config loader merges this table without enabling disabled hooks.
  return `hooks.state={${[...hashes].map(([key, hash]) => `${JSON.stringify(key)}={trusted_hash=${JSON.stringify(hash)}}`).join(',')}}`
}

export async function discoverHookTrustOverride(cwd, args = [], {
  spawnProcess = spawn, timeoutMs = 20_000,
} = {}) {
  const child = spawnProcess('codex', [...args, 'app-server', '--stdio'], {
    cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  })
  // This discovery process must have neither pane stdin nor a controlling TTY.
  // Do not copy stderr: third-party config/plugin errors may contain secrets.
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  let stage = 'initialize'
  let settled = false
  let timer
  const shutdownHandlers = new Map()
  try {
    return await new Promise((resolvePromise, reject) => {
      const fail = reason => { if (!settled) { settled = true; reject(new Error(reason)) } }
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        const handler = () => fail('Codex hook discovery cancelled')
        shutdownHandlers.set(signal, handler)
        process.on(signal, handler)
      }
      child.on('error', () => fail('cannot start isolated Codex hook discovery'))
      child.on('exit', () => fail('Codex hook discovery exited before completion'))
      child.stdin.on('error', () => fail('Codex hook discovery input failed'))
      timer = setTimeout(() => fail('Codex hook discovery timed out'), timeoutMs)
      lines.on('line', raw => {
        if (settled) return
        let message
        try { message = JSON.parse(raw) } catch { fail('invalid Codex hook discovery protocol'); return }
        if (message.id !== (stage === 'initialize' ? 1 : 2)) return
        if (message.error || !('result' in message)) { fail('Codex hook discovery request failed'); return }
        if (stage === 'initialize') {
          stage = 'hooks/list'
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } })}\n`)
        } else {
          try {
            const override = hookTrustOverride(message.result, cwd)
            settled = true
            resolvePromise(override)
          } catch (error) { fail(error.message) }
        }
      })
      child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'ka_workshop_hook_probe', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      } })}\n`)
    })
  } finally {
    try {
      clearTimeout(timer)
      lines.close()
      child.stdin.destroy()
      // The detached discovery owns its own process group, including any MCP
      // children. Never signal a production/pane process group.
      const terminate = signal => {
        if (child.pid && process.platform !== 'win32') {
          try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
        } else if (child.pid) child.kill(signal)
      }
      terminate('SIGTERM')
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise(done => {
          const cleanupTimer = setTimeout(() => { terminate('SIGKILL'); done() }, 1000)
          child.once('exit', () => { clearTimeout(cleanupTimer); done() })
        })
      }
      // The leader can exit on TERM while a grandchild ignores it and still owns
      // our stdout/stderr pipes. Always clear the dedicated group, even after the
      // leader exits; otherwise the short-lived probe can keep Node alive forever.
      terminate('SIGKILL')
      child.stdout.destroy()
      child.stderr.destroy()
    } finally {
      for (const [signal, handler] of shutdownHandlers) process.removeListener(signal, handler)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [cwd, separator, ...args] = process.argv.slice(2)
  if (!cwd || separator !== '--') {
    console.error('usage: hook-trust-overrides.mjs <cwd> -- [codex configuration arguments]')
    process.exitCode = 2
  } else {
    try {
      const override = await discoverHookTrustOverride(resolve(cwd), args)
      if (override) process.stdout.write(`${override}\n`)
    } catch (error) {
      console.error(`[hook-trust] ${error.message}`)
      process.exitCode = 1
    }
  }
}
