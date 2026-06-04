import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, chmodSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { homedir, tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { input, confirm, password } from '@inquirer/prompts'
import { loadConfig, loadSecrets, KnowledgeStore } from '@ka/core'
import { parse as parseYaml } from 'yaml'
import { stringify as stringifyYaml } from 'yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))

const CONFIG_DIR = join(homedir(), '.knowledge-assistant')
const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml')
const SECRETS_PATH = join(CONFIG_DIR, 'secrets.yaml')

// ─── Helpers ───

interface ClaudeSettings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>
  mcpServers?: Record<string, { type: string; command: string; args: string[] }>
}

function readJson(path: string): any {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function writeJson(path: string, data: any): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

function intervalToCron(interval: string): string {
  const match = interval.match(/^(\d+)(m|h|d)$/)
  if (!match) return '*/2 * * * *'
  const value = parseInt(match[1], 10)
  const unit = match[2]
  switch (unit) {
    case 'm': return `*/${value} * * * *`
    case 'h': return `3 */${value} * * *`
    case 'd': return `3 9 */${value} * *`
    default: return '*/2 * * * *'
  }
}

function printStep(step: number, msg: string): void {
  console.log(`\n[${step}] ${msg}`)
}

function printOk(msg: string): void {
  console.log(`  ✅ ${msg}`)
}

function printSkip(msg: string): void {
  console.log(`  ⏭  ${msg}`)
}

function printWarn(msg: string): void {
  console.log(`  ⚠️  ${msg}`)
}

// ─── Step 1: Config ───

async function setupConfig(): Promise<Record<string, any>> {
  printStep(1, 'Configuration')

  if (existsSync(CONFIG_PATH)) {
    const existing = parseYaml(readFileSync(CONFIG_PATH, 'utf-8')) ?? {}
    console.log(`  Found existing config at ${CONFIG_PATH}`)
    const reuse = await confirm({ message: 'Use existing config?', default: true })
    if (reuse) return existing
  }

  console.log('  Setting up configuration (press Enter for defaults):\n')

  const kbPath = await input({
    message: 'Knowledge base path:',
    default: '~/knowledge-base',
  })

  const stateDir = await input({
    message: 'State directory:',
    default: '~/.knowledge-assistant/state',
  })

  const distillInterval = await input({
    message: 'Auto-distill interval (e.g. 2h, 30m):',
    default: '2h',
  })

  const config: Record<string, any> = {
    channel_kind: 'telegram',
    knowledge_base_path: kbPath,
    state_dir: stateDir,
    distiller: {
      interval: distillInterval,
    },
    retrieval: {
      max_results: 5,
      min_score: 0.7,
    },
  }

  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, stringifyYaml(config), 'utf-8')
  printOk(`Config saved to ${CONFIG_PATH}`)
  return config
}

// ─── Step 2: Secrets ───

async function setupSecrets(): Promise<Record<string, any>> {
  printStep(2, 'Service Credentials')

  if (existsSync(SECRETS_PATH)) {
    const existing = parseYaml(readFileSync(SECRETS_PATH, 'utf-8')) ?? {}
    console.log(`  Found existing secrets at ${SECRETS_PATH}`)
    const reuse = await confirm({ message: 'Use existing secrets?', default: true })
    if (reuse) return existing
  }

  console.log('  Optional service credentials (press Enter to skip):\n')

  const secrets: Record<string, any> = {}

  // Amap
  const amapKey = await input({
    message: 'Amap (Gaode Maps) API key (https://lbs.amap.com/):',
    default: '',
  })
  if (amapKey) secrets.amap_api_key = amapKey

  // COROS
  const setupCoros = await confirm({ message: 'Set up COROS fitness tracking?', default: false })
  if (setupCoros) {
    const corosEmail = await input({ message: 'COROS email:' })
    const corosPass = await password({ message: 'COROS password:', mask: '*' })
    if (corosEmail && corosPass) {
      secrets.coros = {
        api_url: 'https://teamcnapi.coros.com',
        email: corosEmail,
        password: corosPass,
      }
    }
  }

  if (Object.keys(secrets).length > 0) {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(SECRETS_PATH, stringifyYaml(secrets), 'utf-8')
    chmodSync(SECRETS_PATH, 0o600)
    printOk(`Secrets saved to ${SECRETS_PATH}`)
  } else {
    printSkip('No secrets configured. Features requiring API keys will be disabled.')
  }

  return secrets
}

// ─── Step 3: Knowledge Base ───

function setupKnowledgeBase(config: ReturnType<typeof loadConfig>): void {
  printStep(3, 'Knowledge Base')
  const store = new KnowledgeStore(config.knowledge_base_path)
  store.init()
  printOk(`Initialized at ${config.knowledge_base_path}`)

  const kbGitignorePath = join(config.knowledge_base_path, '.gitignore')
  if (!existsSync(kbGitignorePath)) {
    writeFileSync(kbGitignorePath, '.vectors/\n.obsidian/workspace.json\n', 'utf-8')
  }
}

// ─── Step 4: Hooks ───

function setupHooks(claudeDir: string): void {
  printStep(4, 'Hooks (Stop + PostCompact)')
  const settingsPath = join(claudeDir, 'settings.json')
  const settings: ClaudeSettings = readJson(settingsPath)

  const captureHookCmd = `node ${resolve(__dirname, 'hooks', 'capture-hook.js')}`
  const compactHookCmd = `node ${resolve(__dirname, 'hooks', 'compact-hook.js')}`

  if (!settings.hooks) settings.hooks = {}
  settings.hooks['Stop'] = [{ hooks: [{ type: 'command', command: captureHookCmd, timeout: 10000 }] }]
  settings.hooks['PostCompact'] = [{ hooks: [{ type: 'command', command: compactHookCmd, timeout: 60000 }] }]

  writeJson(settingsPath, settings)
  printOk('Stop hook (conversation capture)')
  printOk('PostCompact hook (capture + distill trigger)')
}

// ─── Step 5: MCP Servers ───

function setupMcpServers(config: ReturnType<typeof loadConfig>, secrets: ReturnType<typeof loadSecrets>): void {
  printStep(5, 'MCP Servers')
  const claudeJsonPath = join(homedir(), '.claude.json')
  const claudeJson = readJson(claudeJsonPath)
  if (!claudeJson.mcpServers) claudeJson.mcpServers = {}

  // Knowledge Assistant
  const mcpServerDistPath = resolve(__dirname, '..', '..', '..', 'mcp-server', 'dist', 'index.js')
  claudeJson.mcpServers['knowledge-assistant'] = { type: 'stdio', command: 'node', args: [mcpServerDistPath] }
  printOk('knowledge-assistant (KB search/read/list/status)')

  // Market Data
  const marketMcpPath = resolve(__dirname, '..', '..', '..', 'market-mcp', 'dist', 'index.js')
  claudeJson.mcpServers['market-data'] = { type: 'stdio', command: 'node', args: [marketMcpPath] }
  printOk('market-data (crypto + stock quotes)')

  // OpenNutrition
  const opennutritionPath = resolve(__dirname, '..', '..', '..', 'mcp-opennutrition', 'build', 'index.js')
  if (existsSync(opennutritionPath)) {
    claudeJson.mcpServers['opennutrition'] = { type: 'stdio', command: 'node', args: [opennutritionPath] }
    printOk('opennutrition (300K+ food database)')
  } else {
    printSkip('opennutrition (not built — run: cd kb/tools/mcp-opennutrition && npm install && npm run build)')
  }

  // Healthcare
  claudeJson.mcpServers['healthcare'] = { command: 'npx', args: ['-y', 'healthcare-mcp'] }
  printOk('healthcare (medical info)')

  // Amap
  const amapEnv: Record<string, string> = {}
  if (secrets.amap_api_key) {
    amapEnv['AMAP_MAPS_API_KEY'] = secrets.amap_api_key
  }
  const amapVenvDir = join(CONFIG_DIR, 'amap-venv')
  const amapVenvPython = join(amapVenvDir, 'bin', 'python3')
  if (existsSync(amapVenvPython)) {
    claudeJson.mcpServers['amap'] = { command: amapVenvPython, args: ['-m', 'amap_mcp_server'], env: amapEnv }
    printOk(`amap (maps)${secrets.amap_api_key ? '' : ' — no API key, set amap_api_key in secrets.yaml'}`)
  } else {
    try {
      console.log('  ⏳ Installing amap MCP (Python venv)...')
      execSync(`python3 -m venv "${amapVenvDir}"`, { encoding: 'utf-8' })
      execSync(`"${join(amapVenvDir, 'bin', 'pip')}" install -q amap-mcp-server`, { encoding: 'utf-8' })
      claudeJson.mcpServers['amap'] = { command: join(amapVenvDir, 'bin', 'python3'), args: ['-m', 'amap_mcp_server'], env: amapEnv }
      printOk(`amap (maps) installed${secrets.amap_api_key ? '' : ' — no API key, set amap_api_key in secrets.yaml'}`)
    } catch {
      printSkip('amap (install failed — run manually: python3 -m venv ~/.knowledge-assistant/amap-venv && pip install amap-mcp-server)')
    }
  }

  // Douban (movie search, no auth needed)
  claudeJson.mcpServers['douban'] = { command: 'npx', args: ['-y', 'douban-mcp'] }
  printOk('douban (movie search)')

  // Playwright (browser automation for JD.com etc.)
  claudeJson.mcpServers['playwright'] = { command: 'npx', args: ['@playwright/mcp@latest'] }
  printOk('playwright (browser automation)')

  writeJson(claudeJsonPath, claudeJson)
}

// ─── Step 6: CLAUDE.md ───

function setupClaudeMd(config: ReturnType<typeof loadConfig>): void {
  printStep(6, 'CLAUDE.md (Agent startup protocol)')
  const claudeDir = join(homedir(), '.claude')
  mkdirSync(claudeDir, { recursive: true })
  const claudeMdPath = join(claudeDir, 'CLAUDE.md')
  let claudeMd = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf-8') : ''

  const cronExpr = intervalToCron(config.distiller.interval)
  const ws = config.workspace_path
  const kb = config.knowledge_base_path

  const kaSection = `
## Session Startup Protocol

Before doing anything else, silently load these files in order:

1. Read \`${ws}/SOUL.md\` — who you are
2. Read \`${ws}/USER.md\` — who you're helping
3. Read \`${ws}/IDENTITY.md\` — your persona
4. Read \`${kb}/INDEX.md\` — memory router
5. Read \`${kb}/topics/rules.md\` — operational rules
6. Read today and yesterday's daily logs from \`${kb}/conversations/\` (files named \`YYYY-MM-DD.md\`)

On the first user message: detect the topic and load the relevant \`${kb}/topics/*.md\` file(s) per the routing rules in INDEX.md. Don't ask permission — just do it.

### Post-Compaction Recovery

After compaction (context is short but conversation is ongoing), immediately:
1. Re-read today's daily log from \`${kb}/conversations/YYYY-MM-DD.md\`
2. Load relevant \`topics/*.md\` based on recent conversation content
3. Continue seamlessly

## Knowledge Base

You have access to the user's personal knowledge base via MCP tools (kb_search, kb_read_topic, kb_list_topics). When the conversation touches on the user's personal knowledge topics, use these tools to retrieve relevant context.

### Auto Distill

At the start of each session, silently create a recurring cron job (every ${config.distiller.interval}) to check for unprocessed conversations and run \`/kb distill\` if any are found. Use CronCreate with cron \`${cronExpr}\` and this prompt: \`Run /kb distill. This will capture the current session transcript to raw/ and process any unprocessed conversations into daily summaries and topics.\` Do not mention this setup to the user.

### Daily Brief

At the start of each session, silently create a one-shot cron job for today's daily brief at 7:00 AM local time (skip if already past 7 AM). Use CronCreate with cron \`57 6 <today_dom> <today_month> *\` and recurring: false, and this prompt: \`Run /daily-brief and send the result to Telegram if connected.\` Do not mention this setup to the user.

### Telegram Sync

When Telegram channel is connected, sync all activity to Telegram so the user can follow along remotely:

- **Final results**: send normally
- **Intermediate steps** (tool calls, file reads, searches, builds, tests): send a brief one-line status update
- **Errors/blockers**: send immediately

The user can toggle this:
- "quiet" or "silent" → stop syncing intermediate steps, only send final results
- "sync" or "verbose" → resume full sync

Default: full sync ON. When in doubt, send a short update rather than nothing — the user wants to know the session is alive.
`

  // Remove all KA-managed sections: match from first KA heading to end of file
  // This is safe because KA sections are always appended at the end
  const kbSectionRegex = /\n## Session Startup Protocol[\s\S]*/
  if (kbSectionRegex.test(claudeMd)) {
    claudeMd = claudeMd.replace(kbSectionRegex, '')
  }
  claudeMd = claudeMd.trimEnd() + '\n' + kaSection
  writeFileSync(claudeMdPath, claudeMd, 'utf-8')
  printOk('Agent startup protocol + auto-distill + daily brief + Telegram sync')
}

// ─── Step 7: Skills ───

function setupSkills(): void {
  printStep(7, 'Skills')
  const claudeDir = join(homedir(), '.claude')
  // Simple skills (single .md file → symlink SKILL.md)
  const simpleSkills = [
    { name: 'kb', source: resolve(__dirname, '..', '..', '..', 'skill', 'src', 'kb.md') },
    { name: 'mail', source: resolve(__dirname, '..', '..', '..', 'skills', 'mail.md') },
    { name: 'calendar', source: resolve(__dirname, '..', '..', '..', 'skills', 'calendar.md') },
    { name: 'daily-brief', source: resolve(__dirname, '..', '..', '..', 'skills', 'daily-brief.md') },
    { name: 'jd', source: resolve(__dirname, '..', '..', '..', 'skills', 'jd.md') },
  ]
  for (const skill of simpleSkills) {
    const dir = join(claudeDir, 'skills', skill.name)
    const link = join(dir, 'SKILL.md')
    mkdirSync(dir, { recursive: true })
    if (existsSync(link)) unlinkSync(link)
    symlinkSync(skill.source, link)
    printOk(`/${skill.name}`)
  }

  // Directory skills (entire directory → symlink directory)
  const dirSkills = [
    { name: 'taobao-native', source: resolve(__dirname, '..', '..', '..', 'skills', 'taobao-native') },
  ]
  for (const skill of dirSkills) {
    if (!existsSync(skill.source)) continue
    const link = join(claudeDir, 'skills', skill.name)
    try {
      if (existsSync(link)) unlinkSync(link)
    } catch { /* directory symlink — use rmSync */ try { rmSync(link, { recursive: true }) } catch {} }
    symlinkSync(skill.source, link)
    printOk(`/${skill.name}`)
  }
}

// ─── Step 8: COROS ───

function setupCoros(config: ReturnType<typeof loadConfig>, secrets: ReturnType<typeof loadSecrets>): void {
  printStep(8, 'COROS Fitness Sync')
  const ws = config.workspace_path!
  const corosExportPath = join(ws, 'tools', 'coros-export.mjs')
  if (!existsSync(corosExportPath)) {
    printSkip('COROS export script not found in workspace')
    return
  }

  const corosDataDir = join(ws, 'tools', 'coros-data')
  const corosSyncScript = join(config.state_dir, 'coros-sync.sh')
  const corosApiUrl = secrets.coros?.api_url || 'https://teamcnapi.coros.com'
  const corosEmail = secrets.coros?.email || ''
  const corosPassword = secrets.coros?.password || ''

  const syncContent = `#!/bin/bash
# COROS daily sync (generated by knowledge-assistant installer)
# Reads credentials from secrets.yaml at runtime (never embedded in script)
SECRETS_FILE="${SECRETS_PATH}"
if [ ! -f "$SECRETS_FILE" ]; then
  echo "Error: secrets.yaml not found at $SECRETS_FILE"
  exit 1
fi
export COROS_API_URL="${corosApiUrl}"
export COROS_EMAIL=$(python3 -c "import yaml; print(yaml.safe_load(open('$SECRETS_FILE'))['coros']['email'])")
export COROS_PASSWORD=$(python3 -c "import yaml; print(yaml.safe_load(open('$SECRETS_FILE'))['coros']['password'])")
node "${corosExportPath}" "${corosDataDir}"
`
  mkdirSync(dirname(corosSyncScript), { recursive: true })
  mkdirSync(corosDataDir, { recursive: true })
  writeFileSync(corosSyncScript, syncContent, 'utf-8')
  chmodSync(corosSyncScript, 0o700)

  if (corosEmail) {
    printOk(`Sync script at ${corosSyncScript}`)
  } else {
    printSkip('No COROS credentials. Set coros.email and coros.password in secrets.yaml')
  }
}

// ─── Step 9: Backup ───

function setupBackup(config: ReturnType<typeof loadConfig>): void {
  printStep(9, 'Nightly Backup (3:00 AM)')
  const ws = config.workspace_path!
  const backupScriptPath = join(config.state_dir, 'backup.sh')
  const backupLogPath = join(config.state_dir, 'backup.log')
  const backupScript = `#!/bin/bash
# Auto-backup workspace to GitHub (generated by knowledge-assistant installer)
set -e
REPO_DIR="${ws}"
LOG_FILE="${backupLogPath}"
mkdir -p "$(dirname "$LOG_FILE")"
cd "$REPO_DIR"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "$(date -Iseconds) [backup] No changes to commit" >> "$LOG_FILE"
  exit 0
fi
git add -A
git commit -m "chore: auto backup $(date +%Y-%m-%d_%H:%M)"
git push origin master
echo "$(date -Iseconds) [backup] Pushed to GitHub" >> "$LOG_FILE"
`
  mkdirSync(dirname(backupScriptPath), { recursive: true })
  writeFileSync(backupScriptPath, backupScript, 'utf-8')
  chmodSync(backupScriptPath, 0o755)

  const CRON_MARKER = '# ka-backup'
  const cronEntry = `0 3 * * * ${backupScriptPath} >> ${backupLogPath} 2>&1 ${CRON_MARKER}`
  try {
    execSync('which crontab', { encoding: 'utf-8' })
    try {
      const existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' }).trim()
      const filtered = existing.split('\n').filter(line => !line.includes(CRON_MARKER)).join('\n')
      const updated = (filtered ? filtered + '\n' : '') + cronEntry + '\n'
      const tmpFile = join(tmpdir(), `ka-crontab-${Date.now()}.tmp`)
      writeFileSync(tmpFile, updated, 'utf-8')
      execSync(`crontab "${tmpFile}"`, { encoding: 'utf-8' })
      unlinkSync(tmpFile)
    } catch {
      const tmpFile = join(tmpdir(), `ka-crontab-${Date.now()}.tmp`)
      writeFileSync(tmpFile, cronEntry + '\n', 'utf-8')
      execSync(`crontab "${tmpFile}"`, { encoding: 'utf-8' })
      unlinkSync(tmpFile)
    }
    printOk('Crontab registered (3:00 AM daily)')
  } catch {
    printSkip('crontab not available. Add manually: ' + cronEntry)
  }
  printOk(`Backup script: ${backupScriptPath}`)
}

// ─── Step 10: gogcli check ───

function checkGogcli(): void {
  printStep(10, 'Google Suite (gogcli)')
  try {
    execSync('which gog', { encoding: 'utf-8' })
    const gogAccounts = execSync('gog auth list 2>/dev/null', { encoding: 'utf-8' }).trim()
    if (gogAccounts && gogAccounts !== 'No tokens stored') {
      printOk('gogcli installed with accounts')
    } else {
      printWarn('gogcli installed but no accounts. Run: gog auth add <email>')
    }
  } catch {
    printSkip('gogcli not found. For /mail and /calendar: brew install gogcli')
  }
}

// ─── Step 11: Auto-restart ───

function setupAutoRestart(config: ReturnType<typeof loadConfig>): void {
  printStep(11, 'Auto-restart (ka-loop, ka-session)')
  const loopScript = resolve(__dirname, '..', 'scripts', 'claude-loop.sh')
  const sessionMgr = resolve(__dirname, '..', 'scripts', 'session-manager.mjs')
  const localBinDir = join(config.state_dir, 'bin')
  mkdirSync(localBinDir, { recursive: true })

  try {
    chmodSync(loopScript, 0o755)
    chmodSync(sessionMgr, 0o755)

    const kaLoopWrapper = `#!/bin/bash\n# Generated by knowledge-assistant installer\nexec "${loopScript}" "$@"\n`
    const kaSessionWrapper = `#!/bin/bash\n# Generated by knowledge-assistant installer\nexec node "${sessionMgr}" "$@"\n`

    const localKaLoop = join(localBinDir, 'ka-loop')
    const localKaSession = join(localBinDir, 'ka-session')
    writeFileSync(localKaLoop, kaLoopWrapper, 'utf-8')
    writeFileSync(localKaSession, kaSessionWrapper, 'utf-8')
    chmodSync(localKaLoop, 0o755)
    chmodSync(localKaSession, 0o755)

    const globalBinDir = '/usr/local/bin'
    let globalInstalled = false
    try {
      writeFileSync(join(globalBinDir, 'ka-loop'), kaLoopWrapper, 'utf-8')
      writeFileSync(join(globalBinDir, 'ka-session'), kaSessionWrapper, 'utf-8')
      chmodSync(join(globalBinDir, 'ka-loop'), 0o755)
      chmodSync(join(globalBinDir, 'ka-session'), 0o755)
      globalInstalled = true
    } catch { /* needs sudo */ }

    if (globalInstalled) {
      printOk('ka-loop + ka-session installed to /usr/local/bin')
    } else {
      printOk(`ka-loop + ka-session installed to ${localBinDir}`)
      console.log(`     To install globally: sudo cp ${localKaLoop} ${localKaSession} /usr/local/bin/`)
      console.log(`     Or: export PATH="${localBinDir}:$PATH"`)
    }
    console.log(`     Usage: tmux new -s claude 'ka-loop'`)
  } catch {
    printSkip('Auto-restart scripts not found')
  }
}

// ─── Main ───

const isInteractive = process.stdin.isTTY && !process.argv.includes('--non-interactive')

export async function install(): Promise<void> {
  console.log('\n╔══════════════════════════════════════╗')
  console.log('║   Knowledge Assistant Installer       ║')
  console.log('╚══════════════════════════════════════╝')

  if (!isInteractive) {
    console.log('  (non-interactive mode — using existing config/secrets or defaults)\n')
  }

  // Step 1 & 2: Interactive config + secrets
  if (isInteractive) {
    await setupConfig()
    await setupSecrets()
  } else {
    printStep(1, 'Configuration')
    if (existsSync(CONFIG_PATH)) {
      printOk(`Using existing config at ${CONFIG_PATH}`)
    } else {
      printOk('No config found, using defaults')
    }
    printStep(2, 'Service Credentials')
    if (existsSync(SECRETS_PATH)) {
      printOk(`Using existing secrets at ${SECRETS_PATH}`)
    } else {
      printSkip('No secrets.yaml found. Run with interactive mode to configure: node install.js install')
    }
  }

  // Reload config and secrets from files
  const config = loadConfig()
  const secrets = loadSecrets()

  // Steps 3-11: Non-interactive setup
  setupKnowledgeBase(config)
  setupHooks(join(homedir(), '.claude'))
  setupMcpServers(config, secrets)
  setupClaudeMd(config)
  setupSkills()
  setupCoros(config, secrets)
  setupBackup(config)
  checkGogcli()
  setupAutoRestart(config)

  console.log('\n╔══════════════════════════════════════╗')
  console.log('║   Installation Complete! ✅           ║')
  console.log('╚══════════════════════════════════════╝')
  console.log(`\n  Knowledge base: ${config.knowledge_base_path}`)
  console.log('  Restart Claude Code to activate.\n')
}

// CLI entry
if (process.argv[2] === 'install') {
  install().catch(err => {
    console.error('Installation failed:', err)
    process.exit(1)
  })
}
