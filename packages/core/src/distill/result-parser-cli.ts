import { parseDistillResult } from './result-parser.js'

interface CliArgs {
  logPath: string
  memoryDir: string
  startTime: string
  statsFilePath?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`flag ${a} requires value`)
      return v
    }
    switch (a) {
      case '--log-path': args.logPath = next(); break
      case '--memory-dir': args.memoryDir = next(); break
      case '--start-time': args.startTime = next(); break
      case '--stats-file': args.statsFilePath = next(); break
      case '-h':
      case '--help':
        process.stdout.write(`Usage: ka-parse-distill-result --log-path <path> --memory-dir <path> --start-time <iso> [--stats-file <path>]

Parses the background distill worker's claude headless log and reconciles
the stats JSON the worker LLM was supposed to emit. Falls back through:
  0. stats-file   — the JSON the agent Wrote to --stats-file (most reliable)
  1. result-json  — the .result final-line JSON inside the claude wrapper output
  2. log-grep     — any line in the log containing a stats JSON
  3. mtime-scan   — file counts of memory/{raw,conversations,topics}/*.md
                    touched after --start-time
  4. unknown      — nothing landed

Always exits 0 (parse errors fold into tier="unknown" with notes). Writes a
single JSON object to stdout. Stats fields are null when no tier produced them.
`)
        process.exit(0)
        break
      default: throw new Error(`unknown flag: ${a}`)
    }
  }
  if (!args.logPath) throw new Error('--log-path required')
  if (!args.memoryDir) throw new Error('--memory-dir required')
  if (!args.startTime) throw new Error('--start-time required')
  return args as CliArgs
}

try {
  const args = parseArgs(process.argv.slice(2))
  const result = parseDistillResult({
    logPath: args.logPath,
    memoryDir: args.memoryDir,
    startTimeIso: args.startTime,
    statsFilePath: args.statsFilePath,
  })
  process.stdout.write(JSON.stringify(result))
} catch (e) {
  process.stderr.write(`ka-parse-distill-result: ${(e as Error).message}\n`)
  process.exit(1)
}
