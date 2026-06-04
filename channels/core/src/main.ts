#!/usr/bin/env node
/**
 * Universal channel daemon entry — the single entry point for ALL channel
 * daemons (telegram, lark, …). The platform is a PLUGIN selected at runtime by
 * the KA_PLATFORM_MODULE env (an absolute path to a platform module, set by the
 * launcher / start.sh). channel-core has ZERO static dependency on any concrete
 * platform — it dynamic-imports whatever module it's pointed at.
 *
 * A platform module must export:
 *   - platform: Platform                  (the channel-core Platform impl)
 *   - init(): { host, port, pidPath, logger, numbering }   (load config/state,
 *                                            construct clients, return daemon opts)
 *
 * start.sh: KA_PLATFORM_MODULE=<abs path to telegram-platform.ts|lark-platform.ts> \
 *           node --experimental-strip-types channels/core/src/main.ts
 */
import { pathToFileURL } from 'url'
import { runChannelDaemon } from './daemon.ts'

async function main(): Promise<void> {
  const modPath = process.env.KA_PLATFORM_MODULE
  if (!modPath) {
    process.stderr.write('FATAL: KA_PLATFORM_MODULE is not set (path to the platform module). Exiting.\n')
    process.exit(1)
  }
  let mod: any
  try {
    mod = await import(modPath)
  } catch (e: any) {
    process.stderr.write(`FATAL: cannot import platform module ${modPath}: ${e?.message ?? e}\n`)
    process.exit(1)
  }
  if (!mod.platform || typeof mod.init !== 'function') {
    process.stderr.write(`FATAL: platform module ${modPath} must export { platform, init }. Exiting.\n`)
    process.exit(1)
  }
  runChannelDaemon({ platform: mod.platform, ...mod.init() })
}

// Entrypoint guard: boot ONLY when executed directly, never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
