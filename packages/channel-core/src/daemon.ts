// Daemon orchestration — platform-independent. Wires the channel-core seams
// (logger + numbering), installs process lifecycle handlers, starts the liveness
// probe timer, brings up the HTTP server, and hands control to the platform's
// inbound loop (onListening). The platform owns config/state/inbound/outbound;
// everything universal lives here. server.ts collapses to a Platform impl + one
// runChannelDaemon() call.
import { writeFileSync } from 'fs'
import { setLogger, log } from './log.ts'
import { initNumbering } from './sessions.ts'
import { probeTick, PROBE_INTERVAL_MS } from './probe.ts'
import { createHttpApp } from './http.ts'
import { dispatch } from './dispatch.ts'
import type { Platform } from './platform.ts'

export interface DaemonOptions {
  platform: Platform
  host: string
  port: number
  pidPath: string
  /** The platform's log sink (file + stderr). */
  logger: (msg: string) => void
  /** Channel-number map persistence (platform stores it alongside its cursor state). */
  numbering: {
    numbers: Record<string, number>
    next: number
    persist: (numbers: Record<string, number>, next: number) => void
  }
}

function installSignalHandlers(): void {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE', 'SIGQUIT'] as const) {
    process.on(sig, () => { log(`received ${sig}, exiting`); process.exit(0) })
  }
  process.on('uncaughtException', (e: any) => {
    log(`uncaughtException: ${e?.message ?? e}\n${e?.stack ?? ''}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (r: any) => {
    log(`unhandledRejection: ${r?.message ?? r}\n${r?.stack ?? ''}`)
  })
  process.on('exit', code => log(`process exit(code=${code})`))
}

export function runChannelDaemon(opts: DaemonOptions): void {
  setLogger(opts.logger)
  initNumbering(opts.numbering.numbers, opts.numbering.next, opts.numbering.persist)
  installSignalHandlers()

  try {
    writeFileSync(opts.pidPath, String(process.pid))
  } catch (e: any) {
    log(`cannot write pid file: ${e.message}`)
  }

  setInterval(probeTick, PROBE_INTERVAL_MS)

  const app = createHttpApp(opts.platform)
  const httpServer = app.listen(opts.port, opts.host, async () => {
    log(`${opts.platform.name}-channel daemon listening on ${opts.host}:${opts.port}/mcp (pid=${process.pid})`)
    // Hand the platform a dispatch bound to it; the platform starts its inbound loop.
    await opts.platform.startInbound(
      (targetName, content, metaBase) => dispatch(opts.platform, targetName, content, metaBase),
    )
  })
  // Port-bind singleton: on macOS there is no flock binary, so the launcher can't
  // hold a lock. Binding the fixed port is the portable singleton — a second
  // daemon hits EADDRINUSE and exits cleanly (0) instead of crashing.
  httpServer.on('error', (e: any) => {
    if (e?.code === 'EADDRINUSE') {
      log(`port ${opts.port} already in use — another daemon is running; exiting`)
      process.exit(0)
    }
    log(`http server error: ${e?.message ?? e}`)
    process.exit(1)
  })
}
