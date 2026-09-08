// Retrying an edit of a known message is idempotent. sendMessage is deliberately
// excluded: a lost response does not prove Telegram failed to create the message.
export function canRetryTelegramSend(error: any): boolean {
  const seconds = Number(error?.parameters?.retry_after ?? 0)
  return error?.error_code === 429 && Number.isFinite(seconds) && seconds >= 0 && seconds <= 5
}

export async function retryTelegramEdit(
  edit: () => Promise<unknown>,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await edit(); return null } catch (error: any) {
      const message = String(error?.description ?? error?.message ?? '')
      if (message.includes('message is not modified')) return null
      const code = Number(error?.error_code ?? error?.response?.error_code)
      const transient = code === 429 || code >= 500 || error?.name === 'HttpError' || /Network request|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message)
      const retryAfter = Number(error?.parameters?.retry_after ?? 0)
      if (!transient || attempt === 2 || retryAfter > 5) return 'Telegram message edit failed'
      await wait(Math.max(250 * 2 ** attempt, retryAfter * 1000))
    }
  }
  return 'Telegram message edit failed'
}
