import { allSessions, byName, channelNumberOf, sessionsOf } from './sessions.ts'

export interface RuntimeTargetMessage {
  content: string
  meta: Record<string, string>
}

export interface RuntimeTarget {
  readonly name: string
  readonly runtime: string
  deliver(message: RuntimeTargetMessage): Promise<void>
  isAlive?(): boolean
}

const runtimeTargets = new Map<string, RuntimeTarget>()

export function registerRuntimeTarget(target: RuntimeTarget): void {
  if (runtimeTargets.has(target.name)) {
    throw new Error(`runtime target already registered: ${target.name}`)
  }
  runtimeTargets.set(target.name, target)
}

export function unregisterRuntimeTarget(name: string, target?: RuntimeTarget): void {
  if (target && runtimeTargets.get(name) !== target) return
  runtimeTargets.delete(name)
}

export function runtimeTargetOf(name: string): RuntimeTarget | undefined {
  return runtimeTargets.get(name)
}

export function runtimeTargetEntries(): Array<[string, RuntimeTarget]> {
  return Array.from(runtimeTargets.entries())
}

export function targetCount(name: string): number {
  return sessionsOf(name).length + (runtimeTargets.has(name) ? 1 : 0)
}

export function targetNames(): string[] {
  return Array.from(new Set([...byName.keys(), ...runtimeTargets.keys()]))
}

export function totalTargetCount(): number {
  return allSessions().length + runtimeTargets.size
}

export function onlineTargetListStr(): string {
  const items = targetNames()
    .map(name => ({ name, number: channelNumberOf(name) }))
    .sort((left, right) => left.number - right.number)
    .map(({ name, number }) => `${name}(#${number})`)
  return items.length ? items.join(', ') : '(no active channel)'
}

export function clearRuntimeTargetsForTest(): void {
  runtimeTargets.clear()
}
