"""MCP server for Hong Kong rental property listings.

Scrapes the public, server-rendered HTML of 28Hse.com (which has a
permissive robots.txt and no published Terms of Service) so an LLM agent
can search listings by district / price / room / size.

Personal-use only. Do not deploy as a SaaS or redistribute scraped data.
"""

__version__ = "0.1.0"
