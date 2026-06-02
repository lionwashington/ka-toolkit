export interface TopicExtraction {
  topicName: string
  isNew: boolean
  description?: string
  content: string
  tags: string[]
  sourceConversationId: string
}

export interface DistillResult {
  processedConversations: number
  updatedTopics: string[]
  suggestedTopics: TopicSuggestion[]
}

export interface TopicSuggestion {
  name: string
  description: string
  sourceConversations: string[]
  extractedContent: string
}

export interface DistillerPrompt {
  prompt: string
  conversationIds: string[]
  knownTopics: string[]
}
