import { existsSync } from 'fs'
import { splitDailyLog } from './splitter.js'

interface CliArgs {
  file: string
  threshold: number
  maxChainDepth: number
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { threshold: 1000, maxChainDepth: 5 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`flag ${a} requires value`)
      return v
    }
    switch (a) {
      case '--file': args.file = next(); break
      case '--threshold': args.threshold = Number(next()); break
      case '--max-chain-depth': args.maxChainDepth = Number(next()); break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`unknown flag: ${a}`)
    }
  }
  if (!args.file) throw new Error('--file is required')
  return args as CliArgs
}

function printHelp(): void {
  process.stdout.write(`Usage: ka-split-daily-log --file <path> [options]

Auto-splits a conversations/YYYY-MM-DD.md file when it exceeds the threshold.
Slices at the last \`## Thread N:\` (or legacy \`## 主线 N:\`) heading ≤ threshold (falls back to a hard cut
if no heading is found). Chained: if the resulting part file still exceeds
threshold, recurses up to --max-chain-depth times.

Options:
  --file <path>             Required. Absolute path to the daily log file.
  --threshold <lines>       Line count threshold (default 1000).
  --max-chain-depth <n>     Max recursion depth for chained part splits (default 5).

Output (stdout, JSON): SplitResult — see daily-log/splitter.ts for fields.

Exit codes: 0 success | 1 input error | 2 file error
`)
}

function main(): void {
  let args: CliArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`ka-split-daily-log: ${(e as Error).message}\n`)
    process.exit(1)
  }

  if (!existsSync(args.file)) {
    process.stderr.write(`ka-split-daily-log: file not found: ${args.file}\n`)
    process.exit(2)
  }

  try {
    const result = splitDailyLog(args.file, {
      threshold: args.threshold,
      maxChainDepth: args.maxChainDepth,
    })
    process.stdout.write(JSON.stringify(result))
  } catch (e) {
    process.stderr.write(`ka-split-daily-log: ${(e as Error).message}\n`)
    process.exit(2)
  }
}

main()
