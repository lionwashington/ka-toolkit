import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// Use Node.js built-in fetch (Node 18+)

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3'
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart'
const FETCH_TIMEOUT_MS = 10_000

function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
}

interface CryptoPrice {
  id: string
  symbol: string
  name: string
  price: number
  change24h: number
  marketCap: number
}

interface StockQuote {
  symbol: string
  price: number
  change: number
  changePercent: number
  previousClose: number
  currency: string
}

async function getCryptoPrice(id: string): Promise<CryptoPrice> {
  if (!/^[a-z0-9-]{1,100}$/.test(id)) {
    throw new Error(`Invalid coin ID: ${id}`)
  }
  const res = await fetchWithTimeout(
    `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`
  )
  if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`)
  const data = await res.json()
  const coin = data[id]
  if (!coin) throw new Error(`Coin "${id}" not found`)
  return {
    id,
    symbol: id,
    name: id,
    price: coin.usd,
    change24h: coin.usd_24h_change ?? 0,
    marketCap: coin.usd_market_cap ?? 0,
  }
}

async function getCryptoPrices(ids: string[]): Promise<CryptoPrice[]> {
  for (const id of ids) {
    if (!/^[a-z0-9-]{1,100}$/.test(id)) {
      throw new Error(`Invalid coin ID: ${id}`)
    }
  }
  const idsStr = ids.map(id => encodeURIComponent(id)).join(',')
  const res = await fetchWithTimeout(
    `${COINGECKO_BASE}/simple/price?ids=${idsStr}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`
  )
  if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`)
  const data = await res.json()
  return ids.map(id => {
    const coin = data[id]
    if (!coin) return { id, symbol: id, name: id, price: 0, change24h: 0, marketCap: 0 }
    return {
      id,
      symbol: id,
      name: id,
      price: coin.usd,
      change24h: coin.usd_24h_change ?? 0,
      marketCap: coin.usd_market_cap ?? 0,
    }
  })
}

async function getStockQuote(symbol: string): Promise<StockQuote> {
  if (!/^[A-Z0-9^.=-]{1,20}$/i.test(symbol)) {
    throw new Error(`Invalid ticker symbol: ${symbol}`)
  }
  const res = await fetchWithTimeout(`${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1d`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })
  if (!res.ok) throw new Error(`Yahoo Finance API error: ${res.status}`)
  const data = await res.json()
  const result = data?.chart?.result?.[0]
  if (!result) throw new Error(`Symbol "${symbol}" not found`)
  const meta = result.meta
  const price = meta.regularMarketPrice ?? meta.chartPreviousClose ?? 0
  const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? price
  const change = price - prevClose
  const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0
  return {
    symbol: meta.symbol,
    price,
    change,
    changePercent,
    previousClose: prevClose,
    currency: meta.currency ?? 'USD',
  }
}

function formatCrypto(c: CryptoPrice): string {
  const sign = c.change24h >= 0 ? '+' : ''
  return `${c.name}: $${c.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${sign}${c.change24h.toFixed(2)}% 24h)`
}

function formatStock(s: StockQuote): string {
  const sign = s.change >= 0 ? '+' : ''
  return `${s.symbol}: $${s.price.toFixed(2)} (${sign}${s.changePercent.toFixed(2)}%)`
}

export function createServer() {
  const server = new McpServer({
    name: 'market-data',
    version: '0.1.0',
  })

  server.tool(
    'crypto_price',
    'Get real-time cryptocurrency price. Use CoinGecko IDs: bitcoin, ethereum, solana, etc.',
    {
      id: z.string().describe('CoinGecko coin ID (e.g. bitcoin, ethereum, solana)'),
    },
    async ({ id }) => {
      try {
        const coin = await getCryptoPrice(id.toLowerCase())
        return {
          content: [{ type: 'text', text: formatCrypto(coin) }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Failed to get crypto price: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  server.tool(
    'crypto_prices',
    'Get real-time prices for multiple cryptocurrencies at once.',
    {
      ids: z.string().describe('Comma-separated CoinGecko coin IDs (e.g. bitcoin,ethereum,solana)'),
    },
    async ({ ids }) => {
      try {
        const idList = ids.split(',').map(s => s.trim().toLowerCase())
        const coins = await getCryptoPrices(idList)
        const text = coins.map(formatCrypto).join('\n')
        return {
          content: [{ type: 'text', text }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Failed to get crypto prices: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  server.tool(
    'stock_quote',
    'Get real-time stock quote from Yahoo Finance. Use ticker symbols: NVDA, AAPL, SPY, QQQ, etc.',
    {
      symbol: z.string().describe('Stock ticker symbol (e.g. NVDA, AAPL, SPY)'),
    },
    async ({ symbol }) => {
      try {
        const quote = await getStockQuote(symbol.toUpperCase())
        return {
          content: [{ type: 'text', text: formatStock(quote) }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Failed to get stock quote: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  server.tool(
    'stock_quotes',
    'Get real-time quotes for multiple stocks at once.',
    {
      symbols: z.string().describe('Comma-separated ticker symbols (e.g. NVDA,SPY,QQQ,VTI)'),
    },
    async ({ symbols }) => {
      try {
        const syms = symbols.split(',').map(s => s.trim().toUpperCase())
        const results = await Promise.allSettled(syms.map(getStockQuote))
        const quotes = results
          .filter((r): r is PromiseFulfilledResult<StockQuote> => r.status === 'fulfilled')
          .map(r => r.value)
        const errors = results
          .map((r, i) => r.status === 'rejected' ? `${syms[i]}: ${r.reason?.message ?? 'unknown error'}` : null)
          .filter(Boolean)
        const lines = quotes.map(formatStock)
        if (errors.length > 0) lines.push(`\nFailed: ${errors.join(', ')}`)
        return {
          content: [{ type: 'text', text: lines.join('\n') || 'No results' }],
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Failed to get stock quotes: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }
      }
    }
  )

  return server
}

async function main() {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('Market data MCP server error:', error)
  process.exit(1)
})
