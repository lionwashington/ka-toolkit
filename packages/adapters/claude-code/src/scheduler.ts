import type { DistillResult } from '@ka/core'

export function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)(h|m|d)$/)
  if (!match) throw new Error(`Invalid interval: ${interval}`)
  const value = parseInt(match[1], 10)
  const unit = match[2]
  switch (unit) {
    case 'm': return value * 60 * 1000
    case 'h': return value * 60 * 60 * 1000
    case 'd': return value * 24 * 60 * 60 * 1000
    default: throw new Error(`Unknown unit: ${unit}`)
  }
}

export class DistillScheduler {
  private checkFn: () => boolean
  private onNeedDistill: () => void
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(checkFn: () => boolean, onNeedDistill: () => void, interval: string) {
    this.checkFn = checkFn
    this.onNeedDistill = onNeedDistill
    this.intervalMs = parseInterval(interval)
  }

  start(): void {
    this.timer = setInterval(() => {
      try {
        if (this.checkFn()) {
          this.onNeedDistill()
        }
      } catch (err) {
        console.error('[ka] Scheduler check error:', err)
      }
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
