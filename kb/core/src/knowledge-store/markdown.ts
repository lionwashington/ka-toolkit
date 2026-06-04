import matter from 'gray-matter'

export interface ParsedMarkdown {
  data: Record<string, unknown>
  content: string
}

export function parseFrontmatter(raw: string): ParsedMarkdown {
  const { data, content } = matter(raw)
  return { data, content }
}

export function serializeWithFrontmatter(data: Record<string, unknown>, body: string): string {
  return matter.stringify(body, data)
}
