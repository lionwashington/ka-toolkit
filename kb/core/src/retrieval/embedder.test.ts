import { describe, expect, it } from 'vitest'
import { DEFAULT_EMBED_BATCH_SIZE, resolveEmbedBatchSize } from './embedder.js'

describe('embedding batch sizing', () => {
  it('uses the low-memory production default', () => {
    expect(DEFAULT_EMBED_BATCH_SIZE).toBe(4)
    expect(resolveEmbedBatchSize(undefined, undefined)).toBe(4)
  })

  it('allows a positive environment override', () => {
    expect(resolveEmbedBatchSize(undefined, '8')).toBe(8)
  })

  it('prefers an explicit option and rejects invalid values', () => {
    expect(resolveEmbedBatchSize(2, '8')).toBe(2)
    expect(resolveEmbedBatchSize(0, '0')).toBe(4)
    expect(resolveEmbedBatchSize(undefined, 'not-a-number')).toBe(4)
  })
})
