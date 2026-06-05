// The index manifest — the single source of freshness truth for the KB index.
// Written atomically at the END of every successful (re)build. A long-lived reader
// (the MCP retrieval service) cheaply stats this before each search and re-opens
// the table when `version` bumps — which kills the in-memory staleness that made
// kb_search serve a pre-distill index until restart. `source_mtime_max` lets
// `ka doctor` / `kb_status` flag a stale index (topics newer than the build).
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

export interface IndexManifest {
  engine: string
  /** Monotonic build counter — readers reload when this changes. */
  version: number
  built_at: string
  /** Max mtime (epoch ms) over the indexed source files at build time. */
  source_mtime_max: number
  doc_count: number
  chunk_count: number
  embed_model: string
  status: 'ok' | 'error'
  error: string | null
}

export const MANIFEST_FILE = 'index-manifest.json'

export function readManifest(path: string): IndexManifest | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as IndexManifest
  } catch {
    return null // missing / unreadable → caller treats as "no index yet"
  }
}

/** Atomic write (temp + rename) so a reader never sees a half-written manifest. */
export function writeManifest(path: string, m: IndexManifest): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf-8')
  renameSync(tmp, path)
}

/** Stale = the source files are newer than the last successful build. */
export function isStale(m: IndexManifest | null, currentSourceMtimeMax: number): boolean {
  if (!m || m.status !== 'ok') return true
  return currentSourceMtimeMax > m.source_mtime_max
}
