#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

function stopGroups(data) {
  data.hooks ??= {}
  data.hooks.Stop ??= []
  return data.hooks.Stop
}

function commandOf(handler) {
  return handler && typeof handler === 'object' && typeof handler.command === 'string'
    ? handler.command
    : ''
}

function isCodexCapture(handler) {
  return commandOf(handler).includes('codex-capture-hook.js')
}

function isClaudeCapture(handler) {
  const command = commandOf(handler)
  return !command.includes('codex-capture-hook.js') && /(?:^|[/\\])capture-hook\.js(?:[\s"']|$)/.test(command)
}

function isReplySafety(handler) {
  return commandOf(handler).includes('reply-safety-hook.py')
}

function withoutHandlers(groups, predicate) {
  const result = []
  for (const group of groups) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
      result.push(group)
      continue
    }
    const hooks = group.hooks.filter(handler => !predicate(handler))
    if (hooks.length) result.push({ ...group, hooks })
  }
  return result
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

export function configureCodexHooks(data, hookPath) {
  const groups = withoutHandlers(stopGroups(data), handler =>
    isCodexCapture(handler) || isClaudeCapture(handler) || isReplySafety(handler))
  groups.push({
    hooks: [{ type: 'command', command: `node ${shellQuote(hookPath)}`, timeout: 10 }],
  })
  data.hooks.Stop = groups
  return data
}

export function configureClaudeHooks(data, capturePath, replySafetyPath) {
  const groups = withoutHandlers(stopGroups(data), handler =>
    isCodexCapture(handler) || isClaudeCapture(handler) || isReplySafety(handler))
  groups.push({
    hooks: [{ type: 'command', command: `node ${shellQuote(capturePath)}`, timeout: 10 }],
  })
  groups.push({
    hooks: [{ type: 'command', command: `python3 ${shellQuote(replySafetyPath)}`, timeout: 5 }],
  })
  data.hooks.Stop = groups
  return data
}

function readJson(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function writeJsonAtomic(path, data) {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode })
  chmodSync(temporary, mode)
  renameSync(temporary, path)
}

function main(argv) {
  const [runtime, configPath, firstHook, secondHook] = argv
  if (!runtime || !configPath || !firstHook || (runtime === 'claude' && !secondHook)) {
    throw new Error('usage: configure-runtime-hooks.mjs codex <hooks.json> <codex-hook> | claude <settings.json> <capture-hook> <reply-safety-hook>')
  }
  const data = readJson(configPath)
  if (runtime === 'codex') configureCodexHooks(data, firstHook)
  else if (runtime === 'claude') configureClaudeHooks(data, firstHook, secondHook)
  else throw new Error(`unsupported runtime: ${runtime}`)
  writeJsonAtomic(configPath, data)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
