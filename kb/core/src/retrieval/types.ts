export const SEARCH_MODES = ['embedding', 'fts5'] as const
export type SearchMode = typeof SEARCH_MODES[number]

export interface SearchOptions {
  maxResults?: number
  /** Explicit engine selection. Defaults to retrieval.mode from config. */
  mode?: SearchMode
  filter?: {
    type?: 'topic' | 'conversation'
  }
}

/** Searchable chunk shared by the embedding and FTS5 indexes. */
export interface TextChunkRow {
  id: string
  path: string
  topic: string
  kind: string
  parent: string
  title: string
  heading: string
  chunk_index: number
  text: string
  text_seg: string
  updated: string
}

export interface SearchResult {
  path: string
  title: string
  excerpt: string
  score: number
  type: 'topic' | 'conversation'
}
