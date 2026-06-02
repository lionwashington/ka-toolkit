---
name: jd
description: "JD.com (京东) shopping assistant via Playwright browser automation. Use when the user needs to search products, compare prices, view details, add to cart, or manage orders on JD.com."
user-invocable: true
---

# JD.com Shopping Assistant (Playwright)

Shopping on JD.com via Playwright browser automation MCP.

## Prerequisites

- Playwright MCP must be registered (`@playwright/mcp`)
- User may need to log in to JD.com for cart/order operations

## Commands

### `/jd search <keyword>`
Search products on JD.com.

1. Use `browser_navigate` to go to `https://search.jd.com/Search?keyword=<encoded_keyword>`
2. Wait for page to load
3. Use `browser_snapshot` to get the accessibility tree
4. Parse product listings: title, price, shop, sales
5. Present top 10 results in a clean format

### `/jd detail <url or product_id>`
View product details.

1. Navigate to `https://item.jd.com/<product_id>.html`
2. Snapshot the page
3. Extract: title, price, SKU options, stock status, shop info
4. Present in readable format

### `/jd price <keyword>`
Compare prices — search and sort by price.

1. Navigate to `https://search.jd.com/Search?keyword=<encoded_keyword>&psort=1` (sort by price low to high)
2. Snapshot and parse results
3. Show top 10 cheapest options

### `/jd cart`
View shopping cart.

1. Navigate to `https://cart.jd.com/cart_index`
2. Snapshot and parse cart items
3. Show: product, quantity, price, subtotal

### `/jd add <product_id>`
Add product to cart.

1. Navigate to product page
2. Find and click "Add to Cart" button
3. Confirm action
4. Report success/failure

### `/jd` (no args)
Show help for JD commands.

## Workflow

### Product Search Flow
```
browser_navigate → https://search.jd.com/Search?keyword=xxx
browser_snapshot → parse product list
```

### Product Detail Flow
```
browser_navigate → https://item.jd.com/xxx.html
browser_snapshot → parse title, price, SKUs
browser_click → select SKU if needed
browser_snapshot → get updated price
```

### Add to Cart Flow
```
browser_navigate → product page
browser_click → "加入购物车" button   # literal JD UI label = "Add to Cart"; match on this exact text
browser_snapshot → confirm result
```

## Important Notes

- **Login required** for cart and order operations. If the page redirects to login, tell the user to log in manually in the browser first.
- **Price accuracy**: JD prices are generally accurate on the page (unlike Taobao where you need to click SKUs). But promotional prices may require coupon activation.
- **Anti-scraping**: JD may show CAPTCHAs. If encountered, ask the user to solve it in the browser.
- Use `browser_snapshot` (accessibility tree) instead of `browser_screenshot` for efficiency.
- Keep responses concise when running from Telegram.
- For large result sets, show top 10 and ask if the user wants more.
