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
import { dispatchTargets } from './dispatch.ts'
import type { Platform } from './platform.ts'
import { CodexRuntimeManager, type CodexRuntimeConfig } from './codex/runtime-manager.ts'
import type { Server } from 'node:http'

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
  codex?: CodexRuntimeConfig
}

function installSignalHandlers(cleanup: () => Promise<void>): void {
  let shuttingDown = false
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE', 'SIGQUIT'] as const) {
    process.on(sig, () => {
      if (shuttingDown) return
      shuttingDown = true
      log(`received ${sig}, shutting down`)
      const deadline = new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 5_000)
        timer.unref()
      })
      void Promise.race([cleanup(), deadline])
        .catch(error => log(`shutdown cleanup failed: ${error?.message ?? error}`))
        .finally(() => process.exit(0))
    })
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

  const runtimeManager = opts.codex ? new CodexRuntimeManager(opts.platform, opts.codex) : undefined
  let httpServer: Server | undefined
  const probeTimer = setInterval(probeTick, PROBE_INTERVAL_MS)
  installSignalHandlers(async () => {
    clearInterval(probeTimer)
    await runtimeManager?.stop()
    if (httpServer?.listening) {
      await new Promise<void>(resolve => httpServer!.close(() => resolve()))
    }
  })

  try {
    writeFileSync(opts.pidPath, String(process.pid))
  } catch (e: any) {
    log(`cannot write pid file: ${e.message}`)
  }

  const app = createHttpApp(opts.platform, runtimeManager)
  httpServer = app.listen(opts.port, opts.host, async () => {
    log(`${opts.platform.name}-channel daemon listening on ${opts.host}:${opts.port}/mcp (pid=${process.pid})`)
    // Hand the platform a dispatch bound to it; the platform starts its inbound loop.
    await opts.platform.startInbound(
      (rawTargets, content, metaBase) => dispatchTargets(opts.platform, rawTargets, content, metaBase),
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
