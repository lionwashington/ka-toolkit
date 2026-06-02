import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import type { SessionWatermark, WatermarkData } from './types.js'

export class WatermarkStore {
  private filePath: string

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'watermarks.json')
  }

  get(source: string, sessionId: string): SessionWatermark | null {
    const data = this.load()
    return data[source]?.[sessionId] ?? null
  }

  set(source: string, sessionId: string, watermark: SessionWatermark): void {
    const data = this.load()
    if (!data[source]) data[source] = {}
    data[source][sessionId] = watermark
    this.save(data)
  }

  private load(): WatermarkData {
    if (!existsSync(this.filePath)) return {}
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8'))
    } catch {
      return {}
    }
  }

  private save(data: WatermarkData): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmpPath = this.filePath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmpPath, this.filePath)
  }
}
