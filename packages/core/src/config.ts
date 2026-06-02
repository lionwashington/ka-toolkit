import { readFileSync, existsSync } from 'fs'
import { parse as parseYaml } from 'yaml'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { z } from 'zod'

const TopicInitialSchema = z.object({
  name: z.string(),
  description: z.string(),
})

const ConfigSchema = z.object({
  knowledge_base_path: z.string().default('~/knowledge-base'),
  workspace_path: z.string().optional(),
  state_dir: z.string().default('~/.knowledge-assistant/state'),
  distiller: z.object({
    interval: z.string().default('2h'),
    skip_short_conversations: z.number().default(3),
  }).default({}),
  topics: z.object({
    initial: z.array(TopicInitialSchema).default([]),
    auto_suggest: z.boolean().default(true),
    require_approval: z.boolean().default(true),
  }).default({}),
  retrieval: z.object({
    max_results: z.number().default(5),
    min_score: z.number().default(0.7),
  }).default({}),
  memory: z.object({
    frozen_snapshot: z.boolean().default(false),
  }).default({}),
  // Centralized channel config. Values are channel names (= tmux @ka_channel
  // = a CC process's KA_CHANNEL env). Everything is FAIL-CLOSED: a missing key,
  // an empty list, or a malformed value all mean "do nothing" — never a silent
  // default that acts on the wrong target. `.catch([])` keeps a wrong type from
  // throwing in loadConfig (a broken config must never disrupt a live CC).
  //   capture: which channels' conversations the capture hook stores.
  //   inject:  which channels the cron inject-prompt jobs (distill/daily-brief)
  //            target — each name is resolved to a pane via @ka_channel.
  channels: z.object({
    capture: z.array(z.string()).default([]).catch([]),
    inject: z.array(z.string()).default([]).catch([]),
  }).default({}).catch({ capture: [], inject: [] }),
})

const SecretsSchema = z.object({
  amap_api_key: z.string().optional(),
  coros: z.object({
    api_url: z.string().default('https://teamcnapi.coros.com'),
    email: z.string().optional(),
    password: z.string().optional(),
  }).default({}),
}).default({})

export type KaConfig = z.infer<typeof ConfigSchema>
export type KaSecrets = z.infer<typeof SecretsSchema>

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return join(homedir(), filepath.slice(1))
  }
  return filepath
}

const DEFAULT_CONFIG_PATHS = [
  '~/.knowledge-assistant/config.yaml',
  '~/.knowledge-assistant/config.yml',
]

export function loadConfig(configPath?: string): KaConfig {
  let raw: Record<string, unknown> = {}

  if (configPath) {
    const resolved = expandHome(configPath)
    if (existsSync(resolved)) {
      const content = readFileSync(resolved, 'utf-8')
      try {
        raw = parseYaml(content) ?? {}
      } catch (err) {
        throw new Error(`Failed to parse config at ${resolved}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } else {
    for (const p of DEFAULT_CONFIG_PATHS) {
      const resolved = expandHome(p)
      if (existsSync(resolved)) {
        const content = readFileSync(resolved, 'utf-8')
        try {
          raw = parseYaml(content) ?? {}
        } catch (err) {
          throw new Error(`Failed to parse config at ${resolved}: ${err instanceof Error ? err.message : String(err)}`)
        }
        break
      }
    }
  }

  const config = ConfigSchema.parse(raw)
  config.knowledge_base_path = expandHome(config.knowledge_base_path).replace(/\/+$/, '')
  config.state_dir = expandHome(config.state_dir).replace(/\/+$/, '')
  // workspace_path defaults to parent of knowledge_base_path
  if (config.workspace_path) {
    config.workspace_path = expandHome(config.workspace_path)
  } else {
    config.workspace_path = dirname(config.knowledge_base_path)
  }
  return config
}

/**
 * Decide whether conversations on a given channel should be captured.
 *
 * `channel` is process.env.KA_CHANNEL — the per-pane channel name set by
 * `ka workshop` (main pane = "main"; each mate = its sanitized name; a CC
 * started outside the workshop has none → treated as "").
 *
 * FAIL-CLOSED semantics (better to do nothing than the wrong thing):
 *   - channels.capture non-empty → capture only the listed channels
 *   - empty / missing / malformed → capture NOTHING (false)
 *
 * Never throws — the caller runs inside the Stop hook, where any thrown error
 * would surface in the live CC session.
 */
export function isCaptureChannelAllowed(
  channel: string | undefined,
  config: Pick<KaConfig, 'channels'>,
): boolean {
  try {
    const wl = config?.channels?.capture
    if (!Array.isArray(wl) || wl.length === 0) return false
    return wl.includes(channel ?? '')
  } catch {
    return false
  }
}

/**
 * The channels that cron inject-prompt jobs (distill / daily-brief) target.
 * FAIL-CLOSED: missing / empty / malformed → [] (inject nowhere). Never throws.
 * Each returned name is resolved to a tmux pane via @ka_channel by the caller.
 */
export function injectChannels(config: Pick<KaConfig, 'channels'>): string[] {
  try {
    const arr = config?.channels?.inject
    if (!Array.isArray(arr)) return []
    return arr.filter((c): c is string => typeof c === 'string' && c.length > 0)
  } catch {
    return []
  }
}

const DEFAULT_SECRETS_PATHS = [
  '~/.knowledge-assistant/secrets.yaml',
  '~/.knowledge-assistant/secrets.yml',
]

export function loadSecrets(secretsPath?: string): KaSecrets {
  let raw: Record<string, unknown> = {}

  if (secretsPath) {
    const resolved = expandHome(secretsPath)
    if (existsSync(resolved)) {
      const content = readFileSync(resolved, 'utf-8')
      try {
        raw = parseYaml(content) ?? {}
      } catch (err) {
        throw new Error(`Failed to parse secrets at ${resolved}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } else {
    for (const p of DEFAULT_SECRETS_PATHS) {
      const resolved = expandHome(p)
      if (existsSync(resolved)) {
        const content = readFileSync(resolved, 'utf-8')
        try {
          raw = parseYaml(content) ?? {}
        } catch (err) {
          throw new Error(`Failed to parse secrets at ${resolved}: ${err instanceof Error ? err.message : String(err)}`)
        }
        break
      }
    }
  }

  return SecretsSchema.parse(raw)
}
