---
name: taobao-native
version: 1.0.43
description: "Shopping assistant via Taobao Desktop client. Use when the user needs to search products, view details, add to cart, place orders, check orders, request shipping, or perform any Taobao/Tmall shopping operation."
description_zh: "通过淘宝桌面客户端完成购物相关操作。当用户需要搜索商品、查看详情、加入购物车、下单购买、查看订单、催发货、开发票等淘宝/天猫购物操作时使用。"
---

# Taobao Desktop Client Shopping Assistant

## When to Use

When the user's task involves any of the following shopping operations, **you MUST invoke the desktop client tools through the taobao-native CLI**:

- Search products, compare prices
- View product details (price, shop, images)
- Add to cart
- View/manage orders (request shipping, request invoices, etc.)
- View browsing history, favorites
- Chat with merchants via Wangwang (旺旺, Taobao's built-in chat)
- Any page operation involving Taobao or Tmall

---

## ⚠️ Core Rules (MUST follow)

### 1. Price scenarios MUST fetch the real SKU price

**Any scenario involving product price (price comparison, finding the cheapest, price sorting, etc.) MUST open the product detail page to fetch the real SKU price!**

**Reason**: search-result price / page default price ≠ real SKU price
- The search-result price is often the **starting price of the cheapest spec / accessory**
- The "￥xxx起" ("from ￥xxx") shown on the page is the **default starting price**, not the real price of the target spec
- **Tested example**: an iQiyi Gold annual membership card showed ￥88 in search, but after clicking the annual-card SKU the real price was ￥135

### 2. Wait time for fetching prices

**After clicking a SKU you MUST `sleep 3` seconds!**

The price element is refreshed asynchronously; after clicking a SKU you must wait for the async price refresh to complete. **Do not skip the wait.**

### 3. SKU clicks MUST use index for precise clicking

**Do NOT click a SKU with `click_element --args '{"text":"xxx"}'`!**

Reason: SKU text may be duplicated (e.g. "年卡" / "annual card" and "年卡推荐" / "annual card recommended"), and text matching will click the first one.

Correct approach: `scan_page_elements` to get the full DOM → find the exact index → `click_element --args '{"index":N}'`

---

## What to do when the `taobao-native` command is not recognized

When the `taobao-native` command cannot be recognized or fails to run (e.g. `command not found`), handle it per operating system:

### Windows
1. Check the install directory {location} in %APPDATA%\taobao\install-location.txt, then invoke via cmd: `{locatoin}\bin\taobao-native.cmd` or via bash: `{locatoin}\bin\taobao-native` (this is the actual path the `taobao-native` path points to).
2. If it still fails, try refreshing the current session's `Path` environment variable before every `taobao-native` invocation. The exact refresh method depends on the situation. Example:
   ```powershell
   $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
   ```
3. If it still fails, prompt the user: `需要重启当前Agent，以识别新添加的指令` (You need to restart the current Agent so it can recognize the newly added command)
4. Stop the task immediately after prompting; do not keep attempting other operations.

### macOS
1. Try opening it with `open -a /Applications/淘宝桌面版.app`. If it fails, offer to download and install it for the user; if it succeeds, proceed to steps 2–6.
2. Retry running taobao-native.
3. If it still fails, invoke via `~/Library/Application\ Support/taobao/cli/taobao-runner` (the full path the symlink points to).
4. If it still fails, try refreshing environment variables, e.g. `source ~/.zshrc`, then continue.
5. If it still fails, prompt the user: `需要重启当前Agent，以识别新添加的指令` (You need to restart the current Agent so it can recognize the newly added command)
6. Stop the task immediately after prompting; do not keep attempting other operations.

## Invocation Protocol (mandatory)

Use the locally installed **taobao-native** command (the Taobao Desktop CLI), in the format:

```bash
taobao-native <tool-name> --args '<JSON args>'
```

### Shell Environment Requirements

#### Invocation methods (in priority order)

**Method 1: Bash — most reliable**

In Bash, single quotes are passed through verbatim:
```bash
taobao-native add_to_cart --args '{"sku":["50g 【抗皱饱满】"],"sourceApp":"Qoderwork"}'
```

**Method 2: `--request <file>` — works in any shell, recommended for non-Bash environments**

Arguments are read from the file as UTF-8, completely bypassing the shell and `.cmd` argument handling:
```
# request.json contents: {"tool":"add_to_cart","arguments":{"sku":["50g 【抗皱饱满】"],"sourceApp":"Qoderwork"}}
taobao-native --request request.json -o result.json
```

**Method 3: pass args directly via CMD / PowerShell**

```powershell
# PowerShell
powershell -Command 'taobao-native add_to_cart --args ''{"sku":["50g 【抗皱饱满】","混合偏干性肤质 轻润版"],"sourceApp":"Qoderwork"}'' -o "C:\Users\admin\.qoderwork\workspace\mnpnvqeasd3hwtn3\add_cart.json"'
```

### Important Rules

**Every tool call MUST include the `sourceApp` parameter**, which identifies the name of the calling AI application. For example:

```bash
taobao-native navigate --args '{"page":"home","sourceApp":"Qcoderwork"}'
taobao-native search_products --args '{"keyword":"iPhone","sourceApp":"your-agent"}'
```

The `sourceApp` value is determined by the current AI client, for example `your-agent`.

### Step 1: Check tool help

The "Tool Reference" in this Skill doc already contains full descriptions of the common tools, so **prefer calling them directly based on this doc**. Only use the CLI **`--help`** in the following cases:

- When tool parameters are uncertain, or a tool returns an error: `taobao-native --help <tool-name>` or `taobao-native <tool-name> --help` to view the latest usage
- When you need to confirm the latest available tools: `taobao-native --help` (or `-h`) lists all tools

```bash
taobao-native --help
taobao-native --help open_chat
taobao-native open_chat --help
```

## Typical Workflow

1. `navigate` / `navigate_to_url` — navigate to the target page
2. `read_page_content` — read the page's visible text (use scope to limit the range)
3. `scan_page_elements` — scan interactable elements (use filter to narrow down)
4. `click_element` / `input_text` — perform interactions

> **⚠️ Avoid truncation**: when the returned data is large (e.g. `search_products` typically returns 50+ items), the environment may truncate stdout, showing `...(truncated)`. **You MUST use `-o <file>` for tools that may return a lot of data**, which writes the full result to a file while stdout only prints a summary (including the absolute path in `resultFile`). After getting `resultFile`, read that file for the full JSON.
> - **Recommended**: `taobao-native search_products --args '{"keyword":"连衣裙"}' -o result.json`, then read `result.json` (note: `连衣裙` here is the search keyword "dress")
> - Other tools that easily produce large results (e.g. `read_page_content`, or `scan_page_elements` without a filter) should also use `-o`
> - **The `-o` path must be writable and within the authorized scope**: in restricted environments such as agents / sandboxes, **you MUST use the current workspace or a directory the environment allows writing to** (e.g. a file under the absolute `workspace` path given by the task). Relative paths require the cwd to fall within that scope; if you hit `OUTSIDE_AUTHORIZED_ROOT` or the write is rejected, switch to **`-o "<absolute path under workspace>.json"`** and retry.

## Common Errors

| Error | Cause | Solution |
|------|------|---------|
| Click element failed | Page not finished loading | Wait and retry |
| SKU selection failed | Wrong sku parameter format | Use the exact text returned |
| Empty content read | Page still loading | Wait and read again |
| Element not found | Page changed | Re-scan the page |
| Connection failed / error | Desktop client not started | Start the Taobao desktop client first, or wait for the CLI to auto-launch it |
| **Mistakenly think the result is empty** | Output truncated, shows `...(truncated)` | **Add `-o result.json`** to the call and read the full JSON from the resultFile path in stdout |
| **`OUTSIDE_AUTHORIZED_ROOT` / write rejected** | `-o` points to a path disallowed by the sandbox or policy | Move the output file to an **absolute path under the current task workspace (or an env-allowed dir)**, e.g. `-o "D:\\…\\workspace\\cart_result.json"` |
| Wrong price | Insufficient sleep time | **Sleep 3 seconds** after clicking the SKU |
| Wrong SKU clicked | Matched by text | Use **index** for precise clicking |
| **JSON parse error** (contains CJK chars like `【】`) | Windows `.cmd` strips double quotes and breaks the JSON structure | **Prefer Bash**; otherwise pass args via `--request <file>` |

---

## Tool Reference

### Help (CLI, not page tools)

| Command | Purpose | Notes |
|------|------|------|
| `--help` / `-h` | List currently available tools with their `description` / `inputSchema` |  |
| `--help <tool-name>` | Help troubleshoot when a tool returns an error |  |

### Launch

| Tool | Purpose | Notes |
|------|------|----------|
| launch | Launch the Taobao desktop client | On macOS you can use `open "/Applications/淘宝桌面版.app"` as a fallback |

### Navigation

| Tool | Purpose | Key parameters |
|------|------|----------|
| list_available_pages | Get all available page names and links | **Call this first when unsure of a page name** |
| navigate | Navigate to a preset Taobao page | page: page name; **if page is not in the list it returns all available pages and links — do NOT make up URLs** |
| navigate_to_url | Open a known valid Taobao URL | url (must be a trusted domain such as Taobao/Tmall); **do NOT make up URLs; for preset pages use the navigate tool** |
| close_page | Close the current task page | - |

### Page Reading

| Tool | Purpose | Key parameters |
|------|------|----------|
| get_current_tab | Get the current tab's URL and title | - |
| read_page_content | Extract the page's visible text | scope?, maxLength?, offset? |
| scroll_page | Scroll the page | direction: up/down/top/bottom, selector?, amount? |
| inspect_page | Diagnose the page DOM state (to investigate why an operation failed) | - |

### Page Interaction

| Tool | Purpose | Key parameters |
|------|------|----------|
| scan_page_elements | Scan interactable elements, returns a numbered list | filter?, scope? |
| click_element | Click an element | index (number, precise) or text (text, fuzzy match) |
| input_text | Input text | text, index?, placeholder?, scope?, submit? |
| trigger_keyboard_event | Trigger a single keyboard event (keydown/keyup/keypress) | key or keyCode, eventType?, ctrlKey?, altKey?, shiftKey?, metaKey? |
| trigger_key_sequence | Trigger a sequence of key presses | text (auto-split into chars) or sequence (fine-grained control) |
| hold_keyboard_key | Hold down a key (keydown → hold → keyup) | key or keyCode, duration?, repeatEvents? |

### Search & Products

| Tool | Purpose | Key parameters |
|------|------|----------|
| search_products | Text-search products and return a result list | keyword; type? (optional, default all: all=products, shop=shops, tmall=Tmall products, 22pc_b=enterprise purchasing, pc_taobao=Taobao; when the user mentions "shop", "find a store", "enter the store", etc., prefer type=shop) |
| image_search | Search by image (similar products on Taobao). [Prep before calling] You need the image location first; recommended ways: 1) get the image from the system clipboard and judge whether it matches the image the user sent; 2) ask the user where the image is stored locally. Supports three image input formats: local file path, CDN URL, base64 data. It automatically clicks the image-category cards on the page to get the product list for each category | imagePath (image data: 1) local absolute path like /tmp/xxx.jpg; 2) CDN URL like https://example.com/img.jpg; 3) base64 data like data:image/png;base64,xxx) |
| get_product_skus | **[MUST call before adding to cart]** Get the product's SKU dimensions and selectable spec list | itemId? (if omitted, uses the current product detail page) |
| add_to_cart | Add to cart (automatically handles SKU selection and popups). **You MUST first call `get_product_skus` to get selectable specs, then pass a complete sku parameter** | itemId?, sku (must exactly match the page's SKU dimensions) |
| get_browse_history | Get browsing history | type: product/search/shop |
| submit_product_rating | Submit a product review (auto-fills the form and submits). **[Dedicated review tool — the only way] Do NOT use input_text, click_element, scan_page_elements, etc. on the review page! Those tools cannot correctly operate the review form — you MUST use this tool!** | qualityContent? (single-product review content), qualityContents? (array of per-product review contents, one distinct entry per product), merDsr? (description-match rating 1-5), serviceQualityScore? (seller-service rating 1-5), saleConsignmentScore? (logistics-service rating 1-5), isAppend? (whether it's an appended review), serviceContent? (service review content), imageUrls? (array of image paths), gender? (1=male, 2=female), birthday? (format YYYY-MM-DD), anonymous? (whether anonymous), submit? (whether to auto-submit) |

### Wangwang Chat (旺旺, Taobao's built-in merchant chat)

| Tool | Purpose | Key parameters |
|------|------|----------|
| open_chat | [Required for sending messages] Open Wangwang chat and send a message; this compound tool automatically completes the whole flow | source (scenario), message (message content), imagePath? (image path, single or multiple) |
| send_chat_message | Continue sending messages in an already-opened Wangwang page; can also send images | message (message content), imagePath? (single path, path array, or JSON string array), shopName? (switch shop) |

**imagePath parameter notes:**
- Single image: `"/path/to/image.png"` or `"https://cdn.com/img.jpg"` or `"data:image/png;base64,..."`
- Multiple images (array format): `["/path/img1.png", "/path/img2.png"]`
- Image + text order: **send the images first (one by one), then the text**; after sending each image, wait for the popup confirmation

**open_chat scenario notes:**
- `source: cart` - find a product in the cart and message about it; requires `productName` (product keyword)
- `source: order` - find a product in the order list and message about it; requires `productName` (product keyword)
- `source: search` - search for a product, then message the merchant; requires `query` (search term)

**Trigger keywords:** when the user mentions "ask the merchant", "Wangwang" (旺旺), "chat", "inquire", or "send a message", you MUST use the `open_chat` tool

### Keyboard Operations

| Tool | Purpose | Key parameters |
|------|------|----------|
| trigger_keyboard_event | Trigger a single keyboard event | key (key name) or keyCode (number), eventType (keydown/keyup/keypress), modifier keys (ctrlKey/altKey/shiftKey/metaKey) |
| trigger_key_sequence | Trigger a sequence of key presses | text (auto-split into chars) or sequence (fine-grained control array) |
| hold_keyboard_key | Hold down a key | key/keyCode, duration (hold time in ms, default 500), repeatEvents (whether to repeatedly fire keydown) |

**Keyboard operation notes:**

- **trigger_keyboard_event**: used to trigger a single keyboard event
  - `key`: key name such as `"Enter"`, `"Escape"`, `"ArrowUp"`, `"ArrowDown"`, `"Backspace"`, `"Delete"`, `"Tab"`, `"Space"`, letters/digits, etc.
  - `keyCode`: numeric key code, e.g. 13 (Enter), 27 (Escape), 38 (up arrow)
  - `eventType`: event type, `keydown` (press), `keyup` (release), `keypress`, default `keydown`
  - Modifier keys: `ctrlKey`, `altKey`, `shiftKey`, `metaKey` for key combinations

- **trigger_key_sequence**: used to type text continuously or send shortcut combinations
  - `text`: pass a string directly; it's auto-split into individual characters fired in sequence
  - `sequence`: a fine-grained control array where you can specify each key's event type and modifiers

- **hold_keyboard_key**: used for hold scenarios (e.g. movement in games, continuous deletion)
  - First fires `keydown`, holds for the specified time, then fires `keyup`
  - `repeatEvents=true` repeatedly fires `keydown` during the hold (simulating real keyboard repeat)

**Usage examples:**

```bash
# Press Enter
taobao-native trigger_keyboard_event --args '{"key":"Enter"}'

# Press Ctrl+A to select all
taobao-native trigger_keyboard_event --args '{"key":"a","ctrlKey":true}'

# keydown then keyup (fired separately)
taobao-native trigger_keyboard_event --args '{"key":"ArrowDown","eventType":"keydown"}'
taobao-native trigger_keyboard_event --args '{"key":"ArrowDown","eventType":"keyup"}'

# Type text
taobao-native trigger_key_sequence --args '{"text":"Hello World"}'

# Shortcut combination: Ctrl+A then Delete
taobao-native trigger_key_sequence --args '{"sequence":[{"key":"a","ctrlKey":true},{"key":"Delete"}]}'

# Hold Backspace for 2 seconds (continuous deletion)
taobao-native hold_keyboard_key --args '{"key":"Backspace","duration":2000,"repeatEvents":true}'

# Hold an arrow key to move (game scenario)
taobao-native hold_keyboard_key --args '{"key":"ArrowRight","duration":1000}'
```

---

## Installer Download (read the Reference on demand)

**Do not proactively download and install for the user.** Detailed CDN addresses, naming rules, and silent-install / launch instructions are in the Reference in the same directory:

- **`references/install-download.md`**

**Only open and follow that file in the following cases:**

- The user **explicitly requests** installing, reinstalling, or downloading the Taobao desktop client;
- In the situations below, when the user agrees to let you install it:
  - On Windows, `taobao-native` is **unusable** (e.g. `command not found`) and the "What to do when the command is not recognized" rules above still can't recover it
  - On macOS, `open -a /Applications/淘宝桌面版.app` **fails** and the download/install flow is needed.

For everyday shopping, when the CLI already works, you do **not** need to read that Reference.

---

## Notes

- **Before adding to cart you MUST call `get_product_skus` to get SKU info**, then intelligently choose the spec based on the user's intent/preferences; only ask the user when you cannot determine it
- Tools like `search_products`, `add_to_cart`, `open_chat`, `submit_product_rating` already have the full flow built in — do not perform manual operations after a successful call
- The page needs time to load after navigation; wait before reading content
- read_page_content returns at most 5000 chars by default; use scope to narrow the range. The return value includes a `remainingLength` field; if `truncated: true` and `remainingLength > 0`, pass `offset` to read subsequent content in segments (e.g. `offset: 5000`)
- input_text with submit=true can auto-press Enter to submit (search-box scenario)
- **Wangwang chat MUST use the `open_chat` tool; do not manually navigate to the chat page**
- **Large-result tools like search_products MUST use `-o <file>`, then read the full data from resultFile to avoid truncation**
- CLI output is single-line JSON; with `-o`, stdout is a summary (including resultFile), and a script can read that file to parse
- **Image link handling**: image URLs returned by Taobao may include a `_.webp` suffix; you must **remove that suffix** for them to display correctly (applies to all scenarios such as product main images, SKU images, etc.)

### Product Review Tool Notes

**submit_product_rating** - [Dedicated review tool — the only way] auto-fills and submits the Taobao/Tmall product review form

**Absolutely forbidden**: do NOT use input_text, click_element, scan_page_elements, etc. on the review page! Those tools cannot correctly operate the review form — you MUST use this tool!

**Multiple products MUST have differentiated text**: when one order has multiple products, each product's review content must be different! Do NOT copy the same content!

**Workflow:**
1. Step 1: call this tool (without qualityContent) to get the number of products and product info
2. Step 2: based on each product's name and spec, generate different review content for each product
3. Step 3: call this tool again, passing the qualityContents array (one distinct review per product)

**Parameter rules:**
- Single product: use the qualityContent parameter
- Multiple products: you MUST use the qualityContents array; the array length = number of products, and each element's content must be different!

**Ratings required:** the first review must fill in merDsr (description match), serviceQualityScore (seller service), saleConsignmentScore (logistics service), each 1-5 stars.

**Images optional:** imageUrls takes an array of image paths, shared across all products.

**Appended review:** when isAppend=true, ratings can be omitted.

**Parameter notes:**

| Parameter | Type | Notes |
|------|------|------|
| qualityContent | string | [Single-product only] Required review content for a single product. Use only when the order has exactly one product. Do NOT use this parameter for multiple products! |
| qualityContents | string[] | [Required for multiple products] Required array of per-product review contents. Requirements: 1. array length must equal the number of products; 2. each element must be different review content — no duplicates! 3. order must match the product order on the page. |
| merDsr | number | Description-match rating, 1-5 stars (required for the first review) |
| serviceQualityScore | number | Seller-service rating, 1-5 stars (required for the first review) |
| saleConsignmentScore | number | Logistics-service rating, 1-5 stars (required for the first review) |
| isAppend | boolean | Whether it's an appended review, default false. Ratings can be omitted for an appended review |
| serviceContent | string | Service review content (reviewing the service) |
| imageUrls | string[] | Array of image paths, up to 5. Supports: local file path, CDN URL, base64 data. Shared across all products. |
| gender | number | Gender, 1=male, 2=female |
| birthday | string | Birthday / due date, format YYYY-MM-DD, e.g. 2026-03-13 |
| anonymous | boolean | Whether to review anonymously, default true |
| submit | boolean | Whether to auto-click the submit button, default true |

**Usage examples:**

```bash
# Basic review (stars only)
taobao-native submit_product_rating --args '{"merDsr":5,"serviceQualityScore":5,"saleConsignmentScore":5}'

# Review with text (review content is "Great quality, very satisfied", service content is "The seller was very helpful")
taobao-native submit_product_rating --args '{"merDsr":5,"serviceQualityScore":5,"saleConsignmentScore":5,"qualityContent":"商品质量很好，非常满意","serviceContent":"卖家服务态度很好"}'

# Review with photos (review content is "Great")
taobao-native submit_product_rating --args '{"merDsr":5,"qualityContent":"很好","imageUrls":["/tmp/xxx.jpg","/tmp/yyy.jpg"]}'

# Multi-product review (different content per product: "Product A is great", "Product B is nice", "Product C is satisfactory")
taobao-native submit_product_rating --args '{"merDsr":5,"serviceQualityScore":5,"saleConsignmentScore":5,"qualityContents":["商品A很好","商品B不错","商品C满意"]}'
```

---

## Scenario Examples

### Add to cart (full flow)
- **Goal**: add a specific product to the cart.
- **CLI call chain**:
  1. `taobao-native get_product_skus --args '{"itemId":"<product ID>"}'`: **[Required]** first get the product's SKU dimensions and selectable specs (with images)
  2. Example response: `{"success":true,"hasSku":true,"availableSkus":[{"label":"颜色","options":[{"text":"黑色","image":"https://..."},{"text":"白色","image":"https://..."}]},{"label":"尺码","options":[{"text":"M"},{"text":"L"},{"text":"XL"}]}],...}` (here `颜色`=Color with options `黑色`=Black / `白色`=White, and `尺码`=Size)
  3. **Intelligently select the SKU** (judge in priority order):
     - **Case A - the user already expressed intent**: if the user's request already contains spec info (e.g. "add the black XL T-shirt", "buy the large one"), directly match the corresponding option in `availableSkus` and auto-fill the sku parameter
     - **Case B - the user's preference can be inferred**: if the context lets you infer the user's preference (e.g. prior conversation mentioned liking a certain color, or a previously purchased size), automatically select the matching spec
     - **Case C - cannot determine**: only when you genuinely cannot determine the user's intent and preference, show the available specs to the user, **and you MUST also show the `image`** (using Markdown image syntax `![color name](image URL)`) to help the user choose visually
  4. `taobao-native add_to_cart --args '{"itemId":"<product ID>","sku":["黑色","XL"]}'`: pass the complete sku array to add to cart (`黑色`=Black)
- **Key notes**:
  - The `sku` parameter must exactly match the number of SKU dimensions on the page; e.g. if the page has two dimensions "颜色" (Color) and "尺码" (Size), you must pass two values
  - If `get_product_skus` returns `hasSku: false`, the product has no multiple specs and you can call `add_to_cart` directly without sku
  - If `get_product_skus` returns `allSelected: true`, the specs on the page are already fully selected and you can add to cart directly
  - When auto-selecting a SKU, if the chosen spec is out of stock (`disabled: true`), tell the user and have them re-select
  - **When showing specs to the user, you MUST present SKU options that have images in image+text form**, for example:
    ```
    Please choose a color:
    1. ![Black](https://img.alicdn.com/xxx.jpg) Black
    2. ![White](https://img.alicdn.com/yyy.jpg) White
    ```
  - **⚠️ Image link handling**: if a SKU image URL contains a `_.webp` suffix, you must **remove that suffix** for it to display correctly

### Fetch the real SKU price of a product (price-comparison scenario)
- **Goal**: get the **real price of a specific SKU spec** from the product detail page, for price comparison, price sorting, etc.
- **⚠️ Core problem**: search-result price / page default price ≠ real SKU price
  - The search-result price is often the **starting price of an accessory / cheapest spec**, not the main product's price
  - Directly reading the "￥xxx起" ("from ￥xxx") shown on the page is also the **default starting price**, not the real price of the target spec
  - Example: an iQiyi Gold annual membership card showed ￥88 in search, but after clicking the annual-card SKU the real price was ￥135
- **The only reliable method**:
  ```bash
  # 1. Open the product page
  taobao-native navigate_to_url --args '{"url":"https://item.taobao.com/item.htm?id=xxx","sourceApp":"copaw"}'
  sleep 3  # wait for the page to load

  # 2. Get the SKU dimensions
  taobao-native get_product_skus --args '{"sourceApp":"copaw"}'

  # 3. Scan the full DOM and find the target SKU index
  taobao-native scan_page_elements --args '{"sourceApp":"copaw"}' -o elements.json
  # Find the exact index of the target SKU in the DOM

  # 4. Click the SKU precisely by index (do NOT use text!)
  taobao-native click_element --args '{"index":80,"sourceApp":"copaw"}'

  # 5. ⚠️ Wait 3 seconds for the price to refresh (required!)
  sleep 3

  # 6. Get the real price (filter "￥" is the CNY currency symbol shown on the page)
  taobao-native scan_page_elements --args '{"filter":"￥","sourceApp":"copaw"}'
  ```
- **Common pitfalls**:

  | Pitfall | Symptom | Correct approach |
  |------|------|---------|
  | Search price ≠ real price | Shows ￥88, actually ￥135 | Open the detail page and get the real SKU price |
  | Price not refreshed | Insufficient sleep gets the old price | **Sleep 3 seconds** |
  | Wrong SKU clicked | Text match clicked the wrong SKU | Click precisely by **index** |
  | read_page_content gets wrong price | Multiple prices confused | Use `scan_page_elements --args '{"filter":"￥"}'` |

### Get the main image from a product detail page
- **Goal**: extract the main image URL from the product detail page.
- **CLI call chain**:
  1. `taobao-native navigate_to_url --args '{"url":"<detail URL>"}'`: open the detail page
  2. `taobao-native read_page_content --args '{}'`: read the page content. In the return value, the `[商品主图]` (main product image) and `[商品图]` (product image) tags have already auto-extracted image URLs — **no need to specify scope**
- **Tested response example**:
  ```
  [商品图] https://img.alicdn.com/imgextra/.../O1CN01yyy.jpg
  ```
- **⚠️ Image link handling**: the returned image URL needs the `_.webp` suffix **removed** to display correctly

### View and summarize reviews
- **Goal**: view and summarize the user reviews of a product.
- **CLI call chain**:
  1. `taobao-native navigate_to_url --args '{"url":"<detail URL>"}'`: open the detail page
  2. `taobao-native click_element --args '{"text":"用户评价"}'`: click the reviews tab (`用户评价` = "User Reviews"); `pageChanges.added` returns the review content directly
  3. `taobao-native read_page_content --args '{}'`: read the full page; the reviews come after "用户评价·N" ("User Reviews · N"). **The detail page shows only about 2 preview reviews by default**
  4. (Optional) `taobao-native click_element --args '{"text":"查看全部评价"}'`: to see more reviews, click "查看全部评价" ("View all reviews"); this opens the left-side reviews drawer panel (not a URL navigation)
  5. (Optional) `taobao-native read_page_content --args '{"scope":"[class*=Drawer]"}'`: read all the reviews in the drawer (**about 20**, depending on the actual page); use `taobao-native scroll_page --args '{"direction":"down"}'` to load more within the drawer

### Delete a product from the cart
- **Goal**: delete a specific product from the cart.
- **CLI call chain**:
  1. `taobao-native navigate --args '{"page":"cart"}'`: open the cart
  2. `taobao-native input_text --args '{"text":"product keyword","placeholder":"搜索购物车内商品","submit":true}'`: search for the target product in the cart's search box (placeholder `搜索购物车内商品` = "Search products in cart"); after filtering, only matching products are shown
  3. `taobao-native scan_page_elements --args '{}'`: **without a filter**, scan the full DOM tree; the search has greatly reduced the number of products, and in the full tree the product name `<a>product title</a>` and the delete button `<div>删除</div>` (`删除` = "Delete") alternate in order, so they map accurately
  4. Based on the product title and spec info in the DOM tree (e.g. `颜色分类：冲牙器-绿色`, "Color: water flosser - green"), find the index of the `<div>删除</div>` ("Delete") button that **immediately follows** the target product
  5. `taobao-native click_element --args '{"index":<delete button index>}'`: click that product's delete button (**no need to tick the checkbox first**)
  6. `taobao-native click_element --args '{"text":"删除"}'` or `taobao-native click_element --args '{"index":<confirm index>}'`: click confirm in the confirmation popup (`删除` = "Delete")

### Send a product link in Wangwang chat from a detail page
- **Goal**: open Wangwang chat on the product detail page and send the product (or a recommended product on the right) to the merchant.
- **CLI call chain**:
  1. `taobao-native navigate_to_url --args '{"url":"<detail URL>"}'`: open the detail page
  2. `taobao-native click_element --args '{"text":"联系客服"}'`: click "联系客服" ("Contact Customer Service") at the bottom of the detail page to open the Wangwang chat page
  3. `taobao-native scan_page_elements --args '{"filter":"发送"}'`: scan the right sidebar (filter `发送` = "Send"); returns e.g.:
     - `发送宝贝链接` ("Send item link") — send the product currently being inquired about
     - `发送商品` ("Send product", multiple) — send products from the right-side "历史逛过" ("Recently viewed") or "本店推荐" ("Store recommendations")
     - The product name `<div>product title</div>` comes **immediately before** the corresponding `<div>发送商品</div>`
  4. `taobao-native click_element --args '{"index":<corresponding index>}'`: click "发送宝贝链接" ("Send item link") or "发送商品" ("Send product"), and the product link is automatically sent into the chat
- **Tested DOM structure**:
  ```
  [146] <div>发送宝贝链接</div>          ← the product currently being inquired about ("Send item link")
  [152] <div>商品A标题</div>             ← Recently viewed / Store recommendations (Product A title)
  [153] <div>发送商品</div>              ← click to send Product A ("Send product")
  [156] <div>商品B标题</div>             ← Product B title
  [157] <div>发送商品</div>              ← click to send Product B ("Send product")
  ```
- **Key notes**:
  - The right sidebar has four areas: "正在咨询的宝贝" ("Item being inquired about"), "本店订单" ("Orders from this store"), "历史逛过" ("Recently viewed"), and "本店推荐" ("Store recommendations")
  - To send a specific recommended product, first match the product title in the DOM, then click the `发送商品` ("Send product") button immediately following it
