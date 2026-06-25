// CLI wrapper for `ka kb lint`. Resolves the KB path from config (or --kb), runs the
// deterministic checks, prints a human report (or --json), and exits 0/1/2 so `ka
// doctor` / cron can gate on it. `--fix` regenerates a catalog INDEX only.
import { existsSync } from 'fs'
import { loadConfig } from '../config.js'
import { lintKb, fixIndex, type LintReport, type LintFinding, type Severity } from './lint.js'

interface CliArgs {
  kb?: string
  config?: string
  json: boolean
  fix: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, fix: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`flag ${a} requires value`)
      return v
    }
    switch (a) {
      case '--kb': args.kb = next(); break
      case '--config': args.config = next(); break
      case '--json': args.json = true; break
      case '--fix': args.fix = true; break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`unknown flag: ${a}`)
    }
  }
  return args
}

function printHelp(): void {
  process.stdout.write(`Usage: ka kb lint [options]

Read-only structural self-check of the knowledge base (Karpathy LLM-Wiki "lint" pillar).
Five deterministic checks: dead wikilinks, orphan topics, INDEX drift, bad/invisible
frontmatter, raw↔topic linkage. No LLM, no native deps.

Options:
  --kb <path>      KB root (default: knowledge_base_path from config.yaml).
  --config <path>  Config file (default: \$KA_CONFIG_DIR/config.yaml).
  --json           Emit the machine-readable report instead of the text summary.
  --fix            Regenerate a CATALOG INDEX.md from disk (the one safe auto-fix).
                   No-op on a minimal/absent INDEX; never touches topic content.
  -h, --help       Show this help.

Exit codes: 0 clean · 1 warnings only · 2 errors present.
`)
}

const SEV_ORDER: Severity[] = ['error', 'warning', 'info']
const SEV_LABEL: Record<Severity, string> = { error: 'ERROR', warning: 'WARN', info: 'INFO' }

function renderText(report: LintReport, fixResult?: { fixed: boolean; reason: string }): string {
  const lines: string[] = []
  const { stats, counts, byCheck } = report
  const w = stats.wikilinks
  lines.push(`KB: ${report.kbPath}`)
  lines.push('── stats ──')
  lines.push(`  topics: ${stats.topics}  ·  conversations: ${stats.conversations}  ·  raw: ${stats.raw}  ·  INDEX=${report.indexStyle}`)
  lines.push(`  wikilinks: ${w.total} total  ·  ${w.resolved} resolved  ·  ${w.broken} broken`)
  lines.push(`  orphan topics (non-meta/noise): ${stats.orphanTopics}`)
  lines.push(`  raw: ${stats.rawDistilled} distilled  ·  ${stats.rawUndistilled} undistilled  ·  ${stats.rawWithValidBackref} with valid back-ref  ·  ${stats.rawNoise} noise  ·  ${stats.rawEmptyBackref} empty back-ref  ·  ${stats.rawDanglingBackref} dangling back-ref`)
  lines.push(`findings: ${counts.error} error · ${counts.warning} warning · ${counts.info} info`)
  if (Object.keys(byCheck).length) {
    lines.push('by check: ' + Object.entries(byCheck).map(([k, v]) => `${k}=${v}`).join('  '))
  }
  if (fixResult) lines.push(`--fix: ${fixResult.fixed ? 'applied' : 'skipped'} — ${fixResult.reason}`)
  lines.push('')

  const bySev = (s: Severity) => report.findings.filter(f => f.severity === s)
  for (const sev of SEV_ORDER) {
    const items = bySev(sev)
    if (!items.length) continue
    lines.push(`── ${SEV_LABEL[sev]} (${items.length}) ──`)
    for (const f of items) {
      let l = `  [${f.check}] ${f.file}: ${f.message}`
      if (f.detail) l += ` — ${f.detail}`
      if (f.suggestion) l += `  (did you mean [[${f.suggestion}]]?)`
      lines.push(l)
    }
    lines.push('')
  }
  if (counts.error + counts.warning + counts.info === 0) lines.push('clean — no issues found.')
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

function main(): void {
  let args: CliArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`ka kb lint: ${(e as Error).message}\n`)
    process.exit(2)
  }

  let kbPath: string
  if (args.kb) {
    kbPath = args.kb
  } else {
    try {
      kbPath = loadConfig(args.config).knowledge_base_path
    } catch (e) {
      process.stderr.write(`ka kb lint: failed to load config: ${(e as Error).message}\n`)
      process.exit(2)
      return
    }
  }
  if (!existsSync(kbPath)) {
    process.stderr.write(`ka kb lint: knowledge base not found: ${kbPath}\n`)
    process.exit(2)
  }

  let fixResult: { fixed: boolean; reason: string } | undefined
  if (args.fix) {
    try {
      fixResult = fixIndex(kbPath)
    } catch (e) {
      process.stderr.write(`ka kb lint --fix: ${(e as Error).message}\n`)
      process.exit(2)
    }
  }

  const report = lintKb(kbPath)
  if (args.json) {
    process.stdout.write(JSON.stringify({ ...report, fix: fixResult ?? null }))
  } else {
    process.stdout.write(renderText(report, fixResult))
  }
  process.exit(report.exitCode)
}

main()
