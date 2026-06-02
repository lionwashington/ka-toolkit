export interface Topic {
  name: string
  description: string
  created: string
  updated: string
  tags: string[]
  content: string
  relatedTopics?: string[]
}

export interface TopicSummary {
  name: string
  description: string
}

export interface IndexData {
  updated: string
  topics: TopicSummary[]
  totalConversations: number
  lastDistilled?: string
}
