import { writeFileSync } from 'fs'
import { join } from 'path'
import type { KnowledgeStore } from '../knowledge-store/store.js'
import type { ConversationCapture } from '../capture/capture.js'
import type { WatermarkStore } from '../watermark/watermark.js'
import type { DistillerPrompt, DistillResult, TopicSuggestion } from './types.js'

export class Distiller {
  private store: KnowledgeStore
  private capture: ConversationCapture
  private watermarks: WatermarkStore

  constructor(store: KnowledgeStore, capture: ConversationCapture, watermarks: WatermarkStore) {
    this.store = store
    this.capture = capture
    this.watermarks = watermarks
  }

  /**
   * Phase 1: Generate distillation prompt from incremental content.
   * Only includes unprocessed conversations.
   * Returns null if nothing to distill.
   */
  generatePrompt(compactSummary?: string): DistillerPrompt | null {
    const unprocessed = this.capture.getUnprocessed()
    if (unprocessed.length === 0) return null

    const knownTopics = this.store.listTopics().map(t => t.name)

    const conversationsText = unprocessed.map(conv => {
      const messages = conv.messages
        .map(m => `${m.role}: ${m.content}`)
        .join('\n\n')
      return `### Conversation ${conv.id} (${conv.timestamp})\n\n${messages}`
    }).join('\n\n---\n\n')

    const summarySection = compactSummary
      ? `\nContext from current session (compact summary):\n${compactSummary}\n`
      : ''

    const prompt = `You are a knowledge distillation assistant. Analyze the following conversations and extract knowledge into topics.

Known topics: ${knownTopics.join(', ') || '(none yet)'}
${summarySection}
For each piece of knowledge found, output a JSON object with:
- topicName: the topic it belongs to (use an existing topic name if it fits)
- isNew: true if this requires a new topic not in the known list
- description: (only if isNew) one-line description of the new topic
- content: the distilled knowledge in Markdown format (use ## headings)
- tags: relevant tags as an array
- sourceConversationId: the conversation ID it came from

Conversations to distill:

${conversationsText}

Respond with valid JSON only: { "extractions": [...] }
If no meaningful knowledge to extract, respond: { "extractions": [] }`

    return {
      prompt,
      conversationIds: unprocessed.map(c => c.id),
      knownTopics,
    }
  }

  /**
   * Phase 2: Process the LLM's response and update knowledge base.
   */
  processResult(response: string, conversationIds: string[]): DistillResult {
    let extractions: any[] = []
    try {
      const parsed = JSON.parse(response)
      extractions = parsed.extractions ?? []
    } catch {
      return { processedConversations: 0, updatedTopics: [], suggestedTopics: [] }
    }

    const updatedTopics = new Set<string>()
    const suggestedTopics: TopicSuggestion[] = []

    for (const extraction of extractions) {
      // Validate required fields from LLM response
      if (!extraction || typeof extraction.topicName !== 'string' || !extraction.topicName.trim()) continue
      if (typeof extraction.content !== 'string' || !extraction.content.trim()) continue
      const tags = Array.isArray(extraction.tags) ? extraction.tags.filter((t: unknown) => typeof t === 'string') : []

      if (extraction.isNew) {
        suggestedTopics.push({
          name: extraction.topicName,
          description: typeof extraction.description === 'string' ? extraction.description : '',
          sourceConversations: [extraction.sourceConversationId],
          extractedContent: extraction.content,
        })
      } else {
        const convId = extraction.sourceConversationId
        const sourceLink = convId ? `\n\nSource: [[conversations/${convId}]]` : ''
        try {
          this.store.appendToTopic(
            extraction.topicName,
            '\n\n' + extraction.content + sourceLink,
            tags,
          )
          updatedTopics.add(extraction.topicName)
        } catch {
          suggestedTopics.push({
            name: extraction.topicName,
            description: typeof extraction.description === 'string' ? extraction.description : '',
            sourceConversations: [convId],
            extractedContent: extraction.content,
          })
        }
      }
    }

    // Only mark distilled if at least one extraction succeeded or had suggestions
    if (updatedTopics.size > 0 || suggestedTopics.length > 0) {
      for (const id of conversationIds) {
        this.capture.markDistilled(id, [...updatedTopics])
      }
    }

    if (updatedTopics.size > 0) {
      this.store.updateIndex()
      try {
        writeFileSync(join(this.store.root, '.last-distill'), new Date().toISOString() + '\n')
      } catch {
        // Non-fatal: stamp is an optimization hint for frozen-snapshot protocol
      }
    }

    return {
      processedConversations: conversationIds.length,
      updatedTopics: [...updatedTopics],
      suggestedTopics,
    }
  }
}
