import { homedir } from 'node:os'

export interface WorkshopCodexTarget {
  name: string
  cwd: string
}

export function normalizeWorkshopCodexTargets(raw: unknown, home = homedir()): WorkshopCodexTarget[] {
  const doc = raw as any
  if (!doc || !Array.isArray(doc.mates)) return []
  const defaultRuntime = String(doc.runtime ?? 'cc').toLowerCase()
  const seen = new Set<string>()
  return doc.mates.flatMap((mate: any) => {
    if (!mate || typeof mate.name !== 'string' || typeof mate.cwd !== 'string') return []
    if (String(mate.runtime ?? defaultRuntime).toLowerCase() !== 'codex') return []
    const name = String(mate.name).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'main'
    if (seen.has(name)) return []
    seen.add(name)
    return [{ name, cwd: String(mate.cwd).replace(/^~(?=\/|$)/, home) }]
  })
}
