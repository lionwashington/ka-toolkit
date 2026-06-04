# Knowledge Assistant 安装指南

[English](../INSTALL.md)

配置自动会话捕获、MCP 工具、定时任务以及 Telegram workshop。本文是唯一权威、与实际部署一致的安装指南。

## 安装如何运作（design ↔ runtime）

KA 在 **design**（本仓库）与 **runtime**（`~/.knowledge-assistant`，即 `KA_HOME`）之间保持严格边界。你在仓库里构建，然后由 `./install.sh` 把构建产物拷贝/打包进 runtime 目录树。**runtime 永不依赖仓库** —— 一旦部署完成，正在运行的 `ka`、MCP 服务、hooks 和守护进程都是自包含的副本，而不是指回你检出目录的符号链接。`KA_HOME` **本身**就是按四部分组织的目录树（没有 `runtime/` 外壳）；你的线上配置 + 状态与代码并列，分别在 `config/` 和 `state/` 两个数据桶里。

```
clone + build  ──►  ./install.sh  ──►  ~/.knowledge-assistant/   (= KA_HOME)
   (design)          (deploy)            shared/bin/ka, {shared,workshop,
                                         channels,cron,kb}/ops, kb/{core/dist,
                                         mcp,hooks,skills,venvs},
                                         channels/<kind>-daemon
                                         + config/ + state/（你的数据）
```

## 前置要求

- **Claude CLI**（`claude`）—— KA 驱动的 agent 运行时。
- **Node.js** >= 20 —— 运行 MCP 服务、hooks 和 telegram 守护进程。
- **pnpm** >= 9 —— 构建 TypeScript 包。
- **uv** —— 构建 Python MCP 的虚拟环境（`hkprop`、`ibkr`）。仅在你使用这些 MCP 时才需要。
- **tmux** —— workshop 会把每个 CC mate 布局到各自的 pane 里。

## 第一步：克隆并构建

```bash
git clone <repo-url> knowledge-assistant
cd knowledge-assistant
pnpm install
pnpm build
```

`pnpm build` 产出 `dist/` 输出，供 `install.sh` 打包进 runtime（core CLI、MCP 服务、CC hooks）。对于 OpenNutrition MCP（原生 `better-sqlite3` + 内置数据集），安装器首次部署时会自行运行 `npm ci && npm run build`，所以该组件的首次部署会比较慢。

## 第二步：部署到 runtime —— `./install.sh`

```bash
./install.sh --dry-run     # 预览：打印每个动作，不做任何改动
./install.sh               # 把所有组件部署进 ~/.knowledge-assistant/（KA_HOME）
```

务必先跑 `--dry-run`。普通的 `./install.sh` 只会把副本**部署**到 runtime 目录树 —— 它**不会**触碰你当前正在运行的任何东西的注册项（你线上的 `~/.claude.json` MCP 条目、正在运行的守护进程、cron plists、`~/.claude/settings.json` hooks、skill 符号链接）。把这些切换到新部署的 runtime 是独立、显式的 `--switch` 步骤（见第六步）。

### runtime 里会落地哪些内容

下表所有路径都相对于 `KA_HOME`（`~/.knowledge-assistant`）。

| 组件 | runtime 路径 | 如何构建 |
|-----------|--------------|----------------|
| `ka` CLI + ops 脚本 | `shared/bin/ka`、`{shared,workshop,channels,cron,kb}/ops/` | 直接拷贝（自定位；无仓库依赖） |
| Node MCP：kb、market | `kb/mcp/{kb,market}/index.mjs` | esbuild `--bundle` 单文件 |
| Node MCP：opennutrition | `kb/mcp/opennutrition/` | 构建 + 拷贝（原生 sqlite + 数据集） |
| Python MCP：ibkr、hkprop | `kb/venvs/{ibkr,hkprop}/` | `uv build` 出 wheel → 安装进 venv |
| Channel 守护进程（telegram + lark） | `channels/{telegram,lark}-daemon/` | esbuild `--bundle` + 脚本（不含密钥） |
| CC hooks（capture/compact） | `kb/hooks/` | esbuild `--bundle`（折叠进 `@ka/core`） |
| core CLI（供 `/kb` 使用） | `kb/core/dist/` | 直接拷贝（tsup 自包含） |
| skills（kb、daily-brief 等） | `kb/skills/<name>/SKILL.md` | 直接拷贝 |
| 配置模板 + 数据目录 | `config/`（`*.example.*` 模板）+ `state/` + `raw/` + `pending-topics/` | 初始化播种，永不覆盖 |

### 单组件部署及其他参数

```bash
./install.sh --only node-mcp        # 只重新部署一个组件
./install.sh --only daemon --dry-run
```

| 参数 | 作用 |
|------|--------|
| `--dry-run` | 打印每个动作；不做任何改动。 |
| `--only <component>` | 只部署单个组件。有效值：`ka`、`node-mcp`、`python-mcp`、`daemon`、`hooks`、`core-cli`、`skills`、`config`。 |
| `--switch` | 部署后，把线上注册项切换到 runtime（MCP、ka 链接、cron、hooks、daemon、skills）。见第六步。 |
| `--rollback` | 恢复 `--switch` 留下的 `.pre-switch` 备份。 |
| `--cleanup-old` | 在确认切换无误后，删除旧的独立守护进程目录和 `.pre-switch` 备份（不可逆）。 |

`KA_HOME=/tmp/ka-itest ./install.sh --dry-run` 会针对一个临时根目录做隔离测试，绝不触碰你真实的 runtime。

## 第三步：把 `ka` 加入 PATH

部署后的 CLI 位于 `~/.knowledge-assistant/shared/bin/ka`。把它所在目录加入 PATH，或者做个符号链接：

```bash
# 方案 A：符号链接到一个已在 PATH 中的目录
ln -sf ~/.knowledge-assistant/shared/bin/ka ~/.local/bin/ka

# 方案 B：加入 PATH（追加到 ~/.zshrc 或 ~/.bashrc）
export PATH="$HOME/.knowledge-assistant/shared/bin:$PATH"
```

（在执行 `--switch` 时，`install.sh` 也会替你管理 `~/.local/bin/ka` 这个符号链接。）验证：

```bash
ka help
```

## 第四步：Telegram-channel 守护进程

该守护进程是一个独立的后台进程，把你的 Telegram 私信与一个或多个 Claude Code 会话桥接起来。它在单一出口持有 bot token —— **CC 进程永不接触 token**。（它取代了已停用的 Claude Code Telegram *插件*；不要使用 `/plugin install telegram` 或 `/telegram:configure`。）

部署后的守护进程代码位于 `~/.knowledge-assistant/channels/telegram-daemon/`，但它**自身不持有任何配置或密钥** —— 它从共享的 `config/` 桶读取：端口（及轮询调优）来自 `config/config.yaml`（`channels.telegram.port`，默认 `9877`），token + owner id 来自 `config/secrets.yaml`（`channels.telegram.{token,owner_chat_id}`）。`install.sh` 永不触碰这两个文件。

1. 通过 [@BotFather](https://t.me/BotFather) 创建一个 bot，记下 token。

2. 找到你的数字 Telegram user id（例如私信 [@userinfobot](https://t.me/userinfobot)）。

3. 配置密钥。把 `channels.telegram` 块加进 `~/.knowledge-assistant/config/secrets.yaml`（若文件不存在，先从模板创建 —— 见[服务凭据](#服务凭据可选)），并 `chmod 600`：

```yaml
# ~/.knowledge-assistant/config/secrets.yaml
channels:
  telegram:
    token: "<your bot token>"               # 来自 @BotFather
    owner_chat_id: "<your numeric telegram user id>"   # 只有此用户能触达守护进程
```

   端口是非密钥项，位于 `config/config.yaml` 的 `channels.telegram.port`（默认 `9877`）；仅在需要改端口时才在那里编辑。守护进程**fail-closed** —— token 或 owner id 为空/缺失则不启动（跑 `ka doctor` 暴露配置错误）。

4. 守护进程通常由 `ka workshop`（第五步）替你启动。如需独立运行：

```bash
~/.knowledge-assistant/channels/telegram-daemon/start.sh    # 幂等
~/.knowledge-assistant/channels/telegram-daemon/status.sh   # 健康检查
curl -s 127.0.0.1:9877/api/status | python3 -m json.tool
```

**安全性：** 只有来自 `owner_chat_id` 的消息才会被处理；`reply` 工具总是回发给 owner（被攻陷的 CC 无法改变投递目标）；`secrets.yaml` 应为 `chmod 600` 且已 gitignore。CC 进程永不接触 token。

## 第五步：首次启动 —— `ka workshop`

```bash
ka workshop                 # 拉起 workshop（分屏 pane 布局）
ka workshop --window        # 每个 CC 一个 tmux 窗口，而非 pane
ka workshop --dry-run       # 预览布局，不实际启动
```

`ka workshop` 会启动 `~/.knowledge-assistant/config/workshop.yaml`（首次安装时由 `config/workshop.example.yaml` 初始化播种 —— 编辑它来声明你的 pane/cwd）中所有标记为 `default: true` 的 mate，每个 mate 都是一个独立的 `claude` 进程，运行在各自的 tmux pane + cwd 里，并确保 telegram 守护进程在运行。在 Telegram 里用 `to <name>: <message>` 把消息路由给某个 mate。

常用动作：

```bash
ka workshop start <name>           # 启动一个已声明的 mate
ka workshop stop  <name>           # 停止一个 pane（不带名字 = 整个 workshop）
ka workshop spawn-mates <name> <workdir>   # 注册一个新 mate 并启动它
ka workshop restart                # 重启整个 workshop（不带名字 = 全部）
```

## 第六步（可选）：把线上注册项切换到 runtime

在全新机器上，你可以直接注册 runtime。在已经跑着旧部署的机器上，`--switch` 会把你线上的注册项切换到新部署的 runtime，并在切换前先备份每个目标：

```bash
./install.sh --switch --dry-run    # 预览切换
./install.sh --switch              # 重新接线 MCP / ka 链接 / cron / hooks / daemon / skills
```

`--switch` 会把 `~/.claude.json` 的 MCP 条目重新指向 `$KA_HOME/kb/mcp/*`，把 `ka` 符号链接指向 `$KA_HOME/shared/bin/ka`，把 cron plists 和 CC hook 路径重新指向 runtime，把任何遗留的守护进程 `state.json` 迁移进 `$KA_HOME/channels/<kind>-daemon/` 并重启活动守护进程，并把 `~/.claude/skills/<name>/SKILL.md` 符号链接到 runtime 副本。（守护进程**密钥**不会自动迁移 —— 请先填好 `config/secrets.yaml channels.<kind>`。）每一步都会留下一个 `.pre-switch` 备份。如果发现哪里不对：

```bash
./install.sh --rollback            # 恢复备份
```

确认切换健康后，可选择性地回收旧布局：

```bash
./install.sh --cleanup-old         # 删除旧守护进程目录 + .pre-switch 备份（不可逆）
```

## 第七步：定时任务 —— `ka cron install`

KA 的 cron 任务（如 `kb-distill`、`daily-brief`）在 `~/.knowledge-assistant/config/cron.yaml` 中声明，并实体化为操作系统级的 launchd/cron 单元。编辑该 yaml 后（或为修复漂移），同步它们：

```bash
ka cron install --dry-run     # 预览将创建的 OS 单元
ka cron install               # 幂等同步：yaml → OS 单元
ka cron list                  # 列出任务及其调度 / 上次运行 / 状态
```

其他子命令：`ka cron add --name N --schedule S --kind K --command C`、`ka cron disable <name>`、`ka cron run <name>`（前台运行，用于调试）、`ka cron uninstall`（移除 OS 单元，保留 yaml）、`ka cron import`（导入旧的 `com.knowledge-assistant.ka.{kb-distill,daily-brief}` plists）。完整设计见 `docs/KA_CRON_DESIGN.md`。

## 第八步：验证

```bash
ka status        # <1s 健康概览：tmux / telegram 守护进程 / mates / cron
ka doctor        # 更深入的诊断 + 修复提示；发现问题时退出码为 1
```

`ka doctor` 会检查守护进程健康、channel 唯一性、pane cwd、mate 存活状态以及 cron 一致性。然后，在一个 Claude Code 会话里：

```
/kb status       # 知识库路径、主题数量、待处理项
/kb topics       # 列出主题（首次安装时为空）
```

## Google 套件（Gmail + 日历）

`/mail` 和 `/calendar` skill 通过 [gogcli](https://github.com/steipete/gogcli) 访问 Google Workspace。

```bash
brew install gogcli
gog auth credentials set /path/to/client_secret.json   # 从 Google Cloud Console 下载的桌面应用客户端 JSON
gog auth add your@gmail.com                            # 打开浏览器 OAuth；每个账户重复一次
gog auth list                                          # 验证
```

如果遇到 "missing client_id/client_secret"，请展平 JSON —— 把 `installed` 键的内容移到顶层。在 `memory/topics/tools.md` 中配置哪些账户用于邮件、哪些用于日历。

| 命令 | 说明 |
|---------|-------------|
| `/mail` 或 `/mail check` | 查看所有账户的未读邮件 |
| `/mail search <query>` | 搜索邮件 |
| `/mail send <to> <subject>` | 发送邮件（发送前先确认） |
| `/calendar` / `/calendar week` | 今日 / 本周日程 |
| `/calendar add <title> <time>` | 创建日程（创建前先确认） |

## 服务凭据（可选）

某些 MCP 需要 key/凭据。它们存放在 `~/.knowledge-assistant/config/secrets.yaml`（已 gitignore —— 切勿提交）：

```bash
cp config/secrets.example.yaml ~/.knowledge-assistant/config/secrets.yaml
```

```yaml
amap_api_key: your_amap_api_key   # https://lbs.amap.com/  （天气/地图/导航）
coros:                            # 健身追踪器同步
  email: your@email.com
  password: your_password
```

如果某个 key 缺失，对应功能会被跳过。

## MCP 工具（由 KA 注册）

| MCP | 工具 | 认证 |
|-----|-------|------|
| knowledge-assistant | `kb_search`、`kb_read_topic`、`kb_list_topics`、`kb_status` | 无 |
| market-data | `crypto_price(s)`、`stock_quote(s)`（CoinGecko / Yahoo） | 无 |
| opennutrition | `search-food-by-name`、`get-food-by-id`、`get-foods`、`get-food-by-ean13` | 无 |
| hkprop | `search_listings`、`get_listing_detail`、`list_districts`、`agent_contact`、`commute_to_school` | 无（Python venv） |
| ibkr | `portfolio_positions`、`portfolio_pnl`、`stock_quote(s)`、`historical_*` | IBKR Gateway |
| amap | 天气 / 地理编码 / 导航 / POI | `amap_api_key` |

购物（`/taobao-native` 通过淘宝桌面版 app，`/jd` 通过 Playwright）以及娱乐（豆瓣）相关的 skill/MCP 也可用；具体细节见各自的 skill 文件。

## /kb 命令与数据流水线

| 命令 | 说明 |
|---------|-------------|
| `/kb distill` | 捕获本次会话记录，然后提炼所有未处理的 `raw/` 文件 |
| `/kb search <query>` | 搜索知识库 |
| `/kb topics` / `/kb read <topic>` | 列出 / 读取主题 |
| `/kb status` / `/kb config` | 知识库状态 / 当前配置 |
| `/kb pause` / `/kb resume` | 暂停 / 恢复捕获（跨会话持久） |
| `/kb suggest-topic` / `/kb approve-topic <name>` | 查看 / 批准建议的主题 |

驱动流水线的触发器：

| 触发器 | 执行内容 |
|---------|--------------|
| `/kb distill`（手动） | 把当前会话捕获到 `raw/`，然后把未处理的 `raw/` 处理成 `conversations/` + `topics/` + `INDEX.md` + RAG 索引 |
| `kb-distill` cron | 与手动相同 —— 在有未处理内容时按调度运行 |
| Stop hook（会话结束） | `kb/hooks` 脚本把原始会话记录写入 `raw/`，按 `session_id` 去重 |
| PostCompact hook | 把原始会话记录写入 `raw/`，然后触发提炼 |

LLM 即是提炼引擎 —— 无任何外部 API 调用。知识库是纯 Markdown，兼容 Obsidian，对 git 友好，且可移植。

### 知识库目录结构

```
workspace_path/               # knowledge_base_path 的上级目录
├── SOUL.md  USER.md  IDENTITY.md  AGENTS.md

memory/ = knowledge_base_path/    # 默认 ~/knowledge-base/
├── INDEX.md                  # 自动同步的主题索引
├── raw/                      # 原始会话记录（Stop/PostCompact hooks）
├── conversations/            # 每日摘要（提炼输出）
├── topics/                   # 带 frontmatter 的结构化知识
├── pending-topics/           # 待审批的主题建议
└── .vectors/                 # RAG 索引（自动生成）
```

## 自定义配置（可选）

所有设置都有默认值 —— 启动时你**不需要**任何配置文件。如需自定义，拷贝并编辑：

```bash
cp config/config.example.yaml ~/.knowledge-assistant/config/config.yaml
```

| 设置项 | 默认值 |
|---------|---------|
| `knowledge_base_path` | `~/knowledge-base/` |
| `workspace_path` | `knowledge_base_path` 的上级目录 |
| 状态目录 | `~/.knowledge-assistant/state` |
| 密钥文件 | `~/.knowledge-assistant/config/secrets.yaml` |
| 提炼间隔 | `2h` |
| 最大搜索结果数 / 最低分数 | 5 / 0.7 |

## 迁移到新机器

1. `git clone <repo> && cd knowledge-assistant && pnpm install && pnpm build`
2. `./install.sh --dry-run` 然后 `./install.sh`
3. 把 `ka` 加入 PATH（第三步）
4. 从旧机器带过来这些：
   - `~/.knowledge-assistant/config/secrets.yaml`（API key + `channels.<kind>` 守护进程 token/owner）
   - `~/.knowledge-assistant/config/cron.yaml` 和 `config/workshop.yaml`
   - 知识库仓库（`git clone`）
   - Google OAuth 凭据（`~/Library/Application Support/gogcli/`）
5. `ka workshop` → `ka cron install` → `ka doctor`
6. `brew install gogcli && gog auth add your@gmail.com`，用于 `/mail` 和 `/calendar`

## 测试

```bash
pnpm test                                   # 所有包的单元测试
cd kb/tools/hkprop-mcp && uv run pytest      # hkprop MCP 测试
```
