import { existsSync, readFileSync } from 'fs'
import { splitTopic, SplitPlan } from './splitter.js'

interface CliArgs {
  topicFile: string
  planFile: string
  force: boolean
  dryRun: boolean
  threshold: number
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { force: false, dryRun: false, threshold: 500 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`flag ${a} requires value`)
      return v
    }
    switch (a) {
      case '--topic-file': args.topicFile = next(); break
      case '--plan-file': args.planFile = next(); break
      case '--threshold': args.threshold = Number(next()); break
      case '--force': args.force = true; break
      case '--dry-run': args.dryRun = true; break
      case '-h':
      case '--help':
        process.stdout.write(`Usage: ka-split-topic --topic-file <path> --plan-file <path> [options]

Mechanically splits a hub-and-spoke topic file based on a plan JSON. The plan
specifies which level-2 (\`## \`) headings move into which sub-topic. Unmentioned
headings stay in the hub file. The hub gets an auto-generated sub-topic index
section delimited by managed comment markers (idempotent on re-run).

Plan JSON shape:
  {
    "subTopics": [
      {
        "name": "investment",
        "title": "Investment positions",
        "description": "IBKR + US stocks + crypto + SGOV",
        "headings": ["## NVDA / QQQ / VTI up", "## Crypto $148K"]
      }, ...
    ]
  }

Options:
  --topic-file <path>       Required. Absolute path to the topic .md.
  --plan-file <path>        Required. Absolute path to the plan JSON.
  --threshold <lines>       Soft threshold for the hub size warning (default 500).
  --force                   Overwrite existing sub-topic files. Default refuses.
  --dry-run                 Parse + validate plan; print intended actions. Don't write.

Exit codes: 0 success | 1 input error | 2 file error | 3 plan validation failure
`)
        process.exit(0)
        break
      default: throw new Error(`unknown flag: ${a}`)
    }
  }
  if (!args.topicFile) throw new Error('--topic-file required')
  if (!args.planFile) throw new Error('--plan-file required')
  return args as CliArgs
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.topicFile)) {
    process.stderr.write(`ka-split-topic: topic file not found: ${args.topicFile}\n`)
    process.exit(2)
  }
  if (!existsSync(args.planFile)) {
    process.stderr.write(`ka-split-topic: plan file not found: ${args.planFile}\n`)
    process.exit(2)
  }
  let plan: SplitPlan
  try {
    plan = JSON.parse(readFileSync(args.planFile, 'utf-8')) as SplitPlan
  } catch (e) {
    process.stderr.write(`ka-split-topic: failed to parse plan JSON: ${(e as Error).message}\n`)
    process.exit(3)
  }

  if (args.dryRun) {
    process.stdout.write(JSON.stringify({
      dryRun: true,
      topicFile: args.topicFile,
      planSubTopics: plan.subTopics.map(st => ({
        name: st.name,
        title: st.title,
        headingCount: st.headings.length,
        headings: st.headings,
      })),
    }, null, 2))
    process.exit(0)
  }

  const result = splitTopic(args.topicFile, plan, { force: args.force, threshold: args.threshold })
  process.stdout.write(JSON.stringify(result))
} catch (e) {
  process.stderr.write(`ka-split-topic: ${(e as Error).message}\n`)
  process.exit(3)
}
