import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the MCP SDK transport so main() doesn't block on stdio
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    close: vi.fn(),
  })),
}))

// Mock McpServer.connect so main() resolves immediately without real I/O
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@modelcontextprotocol/sdk/server/mcp.js')>()
  const OriginalMcpServer = original.McpServer
  class MockMcpServer extends OriginalMcpServer {
    override async connect(_transport: unknown) {
      // no-op: skip real stdio connection
    }
  }
  return { ...original, McpServer: MockMcpServer }
})

// Stub global fetch before the module is imported
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ─── helpers ─────────────────────────────────────────────────────────────────

type ToolEntry = {
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>
}

function getTools(server: unknown): Record<string, ToolEntry> {
  return (server as { _registeredTools: Record<string, ToolEntry> })._registeredTools
}

async function callTool(server: unknown, name: string, args: Record<string, unknown>) {
  return getTools(server)[name].handler(args, {})
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('market-mcp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ─── Server creation ────────────────────────────────────────────────────

  describe('createServer', () => {
    it('creates an MCP server instance with a connect method', async () => {
      const { createServer } = await import('../src/index.js')
      const server = createServer()
      expect(server).toBeDefined()
      expect(typeof server.connect).toBe('function')
    })

    it('registers the expected four tools', async () => {
      const { createServer } = await import('../src/index.js')
      const server = createServer()
      const toolNames = Object.keys(getTools(server))
      expect(toolNames).toContain('crypto_price')
      expect(toolNames).toContain('crypto_prices')
      expect(toolNames).toContain('stock_quote')
      expect(toolNames).toContain('stock_quotes')
    })
  })

  // ─── CoinGecko crypto_price ─────────────────────────────────────────────

  describe('crypto_price tool', () => {
    it('returns formatted price for a valid coin', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bitcoin: {
            usd: 72000,
            usd_24h_change: 3.5,
            usd_market_cap: 1_400_000_000_000,
          },
        }),
      })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      const result = await callTool(server, 'crypto_price', { id: 'bitcoin' }) as {
        content: { type: string; text: string }[]
      }

      expect(result.content[0].text).toContain('bitcoin')
      expect(result.content[0].text).toContain('72,000.00')
      expect(result.content[0].text).toContain('+3.50%')
    })

    it('calls CoinGecko with the correct URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ethereum: { usd: 3500, usd_24h_change: -1.2, usd_market_cap: 420_000_000_000 },
        }),
      })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      await callTool(server, 'crypto_price', { id: 'ethereum' })

      expect(mockFetch).toHaveBeenCalledOnce()
      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('coingecko.com')
      expect(url).toContain('ids=ethereum')
    })

    it('handles non-ok API response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429 })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      const result = await callTool(server, 'crypto_price', { id: 'bitcoin' }) as {
        content: { text: string }[]
        isError: boolean
      }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('CoinGecko API error: 429')
    })

    it('handles unknown coin id', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}), // no entry for the requested id
      })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      const result = await callTool(server, 'crypto_price', { id: 'fakecoin' }) as {
        content: { text: string }[]
        isError: boolean
      }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('"fakecoin" not found')
    })
  })

  // ─── CoinGecko crypto_prices (batch) ────────────────────────────────────

  describe('crypto_prices tool', () => {
    it('returns formatted prices for multiple coins', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bitcoin: { usd: 72000, usd_24h_change: 3.5, usd_market_cap: 1_400_000_000_000 },
          ethereum: { usd: 3500, usd_24h_change: -1.2, usd_market_cap: 420_000_000_000 },
        }),
      })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      const result = await callTool(server, 'crypto_prices', { ids: 'bitcoin,ethereum' }) as {
        content: { text: string }[]
      }

      const text = result.content[0].text
      expect(text).toContain('bitcoin')
      expect(text).toContain('ethereum')
    })

    it('includes all comma-separated ids in the CoinGecko URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bitcoin: { usd: 72000, usd_24h_change: 3.5, usd_market_cap: 1_400_000_000_000 },
          solana: { usd: 155, usd_24h_change: 2.1, usd_market_cap: 70_000_000_000 },
        }),
      })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      await callTool(server, 'crypto_prices', { ids: 'bitcoin,solana' })

      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('bitcoin')
      expect(url).toContain('solana')
    })

    it('returns a zero-value entry for a coin absent from the response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bitcoin: { usd: 72000, usd_24h_change: 3.5, usd_market_cap: 1_400_000_000_000 },
          // 'fakecoin' intentionally absent
        }),
      })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      const result = await callTool(server, 'crypto_prices', { ids: 'bitcoin,fakecoin' }) as {
        content: { text: string }[]
      }

      const lines = result.content[0].text.split('\n')
      expect(lines).toHaveLength(2)
      const fakeLine = lines.find(l => l.includes('fakecoin'))
      expect(fakeLine).toBeDefined()
      expect(fakeLine).toContain('$0.00')
    })
  })

  // ─── Yahoo Finance stock_quote ───────────────────────────────────────────

  describe('stock_quote tool', () => {
    it('returns formatted quote for a valid symbol', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chart: {
            result: [
              {
                meta: {
                  symbol: 'NVDA',
                  regularMarketPrice: 175.44,
                  previousClose: 177.64,
                  currency: 'USD',
                },
              },
            ],
          },
        }),
      })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      const result = await callTool(server, 'stock_quote', { symbol: 'NVDA' }) as {
        content: { text: string }[]
      }

      expect(result.content[0].text).toContain('NVDA')
      expect(result.content[0].text).toContain('175.44')
    })

    it('calculates change percent correctly', async () => {
      const regularMarketPrice = 175.44
      const previousClose = 177.64
      const expectedPct = ((regularMarketPrice - previousClose) / previousClose) * 100

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chart: {
            result: [{ meta: { symbol: 'NVDA', regularMarketPrice, previousClose, currency: 'USD' } }],
          },
        }),
      })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      const result = await callTool(server, 'stock_quote', { symbol: 'NVDA' }) as {
        content: { text: string }[]
      }

      expect(result.content[0].text).toContain(expectedPct.toFixed(2))
    })

    it('calls Yahoo Finance with the correct URL and User-Agent header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          chart: {
            result: [{ meta: { symbol: 'AAPL', regularMarketPrice: 200, previousClose: 198, currency: 'USD' } }],
          },
        }),
      })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      await callTool(server, 'stock_quote', { symbol: 'AAPL' })

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toContain('finance.yahoo.com')
      expect(url).toContain('/AAPL')
      expect((init.headers as Record<string, string>)['User-Agent']).toBeDefined()
    })

    it('handles non-ok API response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      const result = await callTool(server, 'stock_quote', { symbol: 'FAKE' }) as {
        content: { text: string }[]
        isError: boolean
      }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Yahoo Finance API error: 404')
    })

    it('handles missing chart result for unknown symbol', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ chart: { result: null } }),
      })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      const result = await callTool(server, 'stock_quote', { symbol: 'XXXXXX' }) as {
        content: { text: string }[]
        isError: boolean
      }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('"XXXXXX" not found')
    })
  })

  // ─── Yahoo Finance stock_quotes (batch) ─────────────────────────────────

  describe('stock_quotes tool', () => {
    it('returns formatted quotes for multiple symbols', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            chart: {
              result: [{ meta: { symbol: 'SPY', regularMarketPrice: 520, previousClose: 515, currency: 'USD' } }],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            chart: {
              result: [{ meta: { symbol: 'QQQ', regularMarketPrice: 440, previousClose: 438, currency: 'USD' } }],
            },
          }),
        })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      const result = await callTool(server, 'stock_quotes', { symbols: 'SPY,QQQ' }) as {
        content: { text: string }[]
      }

      const text = result.content[0].text
      expect(text).toContain('SPY')
      expect(text).toContain('QQQ')
    })

    it('makes exactly one fetch call per symbol', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            chart: {
              result: [{ meta: { symbol: 'AAPL', regularMarketPrice: 200, previousClose: 198, currency: 'USD' } }],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            chart: {
              result: [{ meta: { symbol: 'MSFT', regularMarketPrice: 420, previousClose: 418, currency: 'USD' } }],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            chart: {
              result: [{ meta: { symbol: 'GOOG', regularMarketPrice: 180, previousClose: 179, currency: 'USD' } }],
            },
          }),
        })

      const { createServer } = await import('../src/index.js')
      const server = createServer()
      await callTool(server, 'stock_quotes', { symbols: 'AAPL,MSFT,GOOG' })

      expect(mockFetch).toHaveBeenCalledTimes(3)
    })
  })
})
