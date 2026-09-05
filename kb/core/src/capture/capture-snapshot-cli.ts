import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createCaptureSnapshot, acknowledgeCaptureSnapshot } from './snapshot.js'

export function main(args = process.argv.slice(2)): void {
  const [command, ...rest] = args
  const flags = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) throw new Error('expected option/value pairs')
    flags.set(rest[i], rest[i + 1])
  }
  const required = (key: string) => { const v = flags.get(key); if (!v) throw new Error(`missing ${key}`); return v }
  if (command === 'snapshot') {
    const snapshot = createCaptureSnapshot(required('--raw-dir'), required('--file'), required('--job'))
    // Explicit snapshot reading is the only command that returns private text.
    const sections = snapshot.body.split(/(?=^## (?:User|Assistant)$)/m).filter(s => s.trim())
    process.stdout.write(JSON.stringify({ ok: true, hash: snapshot.hash, text: sections.slice(snapshot.processedPrefix).join('') }) + '\n')
  } else if (command === 'ack') {
    const result = acknowledgeCaptureSnapshot(required('--job'), JSON.parse(required('--topics-json')))
    process.stdout.write(JSON.stringify({ ok: result.status !== 'conflict', ...result }) + '\n')
    if (result.status === 'conflict') process.exitCode = 3
  } else throw new Error('expected snapshot or ack')
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { main() } catch { process.stderr.write('capture snapshot failed; check arguments, source and local file access\n'); process.exitCode = 1 }
}
