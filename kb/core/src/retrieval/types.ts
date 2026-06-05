export interface SearchOptions {
  maxResults?: number
  filter?: {
    type?: 'topic' | 'conversation'
  }
}

export interface SearchResult {
  path: string
  title: string
  excerpt: string
  score: number
  type: 'topic' | 'conversation'
}
