import { loadConfig, injectChannels } from './config.js'

// config-cli — the single bash-facing reader for config.yaml channel settings.
//
// Usage:  config-cli.js <capture|inject>
// Prints each configured channel name on its own line, then exits 0.
//
// FAIL-CLOSED (better to do nothing than the wrong thing): any error, unknown key, or empty/missing
// config yields NO output and exit 0. Callers (cron-run.sh, doctor.sh) treat
// empty output as "do nothing" — so a broken config never makes us act on the
// wrong target. This is the ONE place the channel lists are read; bash never
// re-implements the fail-closed logic.
function main(): void {
  const key = process.argv[2]
  let out: string[] = []
  try {
    const config = loadConfig()
    if (key === 'capture') out = config.channels?.capture ?? []
    else if (key === 'inject') out = injectChannels(config)
    // unknown key → out stays []
  } catch {
    out = [] // fail-closed: broken config → emit nothing
  }
  if (Array.isArray(out)) {
    for (const c of out) {
      if (typeof c === 'string' && c.length > 0) process.stdout.write(c + '\n')
    }
  }
}

main()
