export interface SessionWatermark {
  lastConversationId: string
  lastTimestamp: string
}

export interface WatermarkData {
  [source: string]: {
    [sessionId: string]: SessionWatermark
  }
}
