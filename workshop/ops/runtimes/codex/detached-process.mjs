#!/usr/bin/env node
// Keep a background runtime and its descendants outside the TUI's controlling
// terminal session. Callers must also redirect all three standard descriptors.
import { spawn } from 'node:child_process'
import { constants } from 'node:os'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('detached-process: command required')
  process.exit(2)
}

const child = spawn(command, args, { detached: true, stdio: 'inherit' })
let stopping = false
let killTimer

function signalGroup(signal) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    signalGroup(signal)
    // A hung sidecar must not hold the pane wrapper's cleanup indefinitely.
    killTimer = setTimeout(() => signalGroup('SIGKILL'), 5000)
    killTimer.unref()
  })
}

child.on('error', error => {
  // Do not print argv: hooks and other children can carry private arguments.
  console.error(`detached-process: spawn failed (${error.code || 'unknown'})`)
  process.exitCode = 127
})

child.on('exit', (code, signal) => {
  clearTimeout(killTimer)
  // This process group belongs only to the sidecar. Reap any descendants left
  // behind when its leader exits, including children which ignored shutdown.
  signalGroup('SIGKILL')
  process.exitCode = code ?? (128 + (constants.signals[signal] || 1))
})
