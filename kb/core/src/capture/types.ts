export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  uuid?: string
}

export interface Conversation {
  id: string
  source: string
  sessionId: string
  timestamp: string
  messages: ConversationMessage[]
  metadata?: Record<string, unknown>
  parseProgress?: ParseProgress
}

export interface ParseProgress {
  offset: number
  lastEntryUuid: string
  messageCount: number
  parsedAt: string
}

export interface JsonlEntry {
  type?: string
  uuid?: string
  parentUuid?: string | null
  timestamp?: string
  sessionId?: string
  isSidechain?: boolean
  message?: {
    role?: string
    content?: unknown
  }
}

export interface JsonlDelta {
  messages: ConversationMessage[]
  newOffset: number
  newEntryUuid: string
  newMessageCount: number
  fellBack: boolean
  reason: string | null
}
