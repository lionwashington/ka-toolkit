// Chinese word segmentation via the built-in Intl.Segmenter (Node >= 20) — zero
// dependency, cross-platform. We pre-segment text into space-joined tokens so
// LanceDB's default (whitespace) FTS tokenizer gives real Chinese lexical recall,
// without LanceDB's native jieba tokenizer (which needs a per-machine dict install).
// English/numbers pass through unchanged. Apply the SAME segmentation to documents
// (at index time) and to the query (at search time).
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' })

export function segment(text: string): string {
  const out: string[] = []
  for (const { segment } of SEGMENTER.segment(text)) {
    const t = segment.trim()
    if (t) out.push(t)
  }
  return out.join(' ')
}
