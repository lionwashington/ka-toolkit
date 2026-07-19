import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { unlinkSync } from 'node:fs'

export async function startFakeSocketServer({ socketPath, fakePath, statePath }) {
  try { unlinkSync(socketPath) } catch {}
  const children = new Set()
  const server = createServer(socket => {
    const child = spawn(process.execPath, [fakePath], {
      env: { ...process.env, FAKE_CODEX_STATE: statePath },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    children.add(child)
    socket.pipe(child.stdin)
    child.stdout.pipe(socket)
    socket.once('close', () => child.kill('SIGTERM'))
    child.once('exit', () => { children.delete(child); socket.destroy() })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    close: () => new Promise(resolve => server.close(() => {
      for (const child of children) child.kill('SIGTERM')
      try { unlinkSync(socketPath) } catch {}
      resolve()
    })),
  }
}
