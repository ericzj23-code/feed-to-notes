# douyin-link-to-obsidian

> **当前能力边界**（v0.6 标签对应 `v0.6-summary-layer`）
>
> | 项 | 状态 |
> |---|---|
> | 单条抖音 URL 抓取 | ✅ 已支持（短链 `v.douyin.com/xxx` + 长链 `www.douyin.com/video/数字ID` + `www.douyin.com/shipin/数字ID`） |
> | 跳转后 URL 记录 | ✅ 已支持（`final_url` 字段单独存 frontmatter） |
> | 标题 | ✅ 已支持 |
> | 作者 | ✅ 已支持 |
> | 发布时间 | ✅ 已支持（`/video/` 用 `data-e2e`；`/shipin/` 用全文正则兜底） |
> | 章节 / 文案 | ✅ 章节已支持稳定（自适应等待连续 2 次相同章节数） |
> | 评论 | ✅ 已支持（默认 10 条，可配置） |
> | 抓取日志 | ✅ 已支持（写入 md 文件 + 控制台输出） |
> | Markdown 输出 | ✅ 已支持（`.md` 文件含 frontmatter + 元数据表 + 章节/评论表格） |
> | 结构化 JSON 输出 | ✅ 已支持（v0.3 新增，`.json` 与 `.md` 同名同目录，14 个字段） |
> | 股票提及提取 | ✅ 已支持（v0.3 新增，纯正则+静态词典，不调 LLM） |
> | Obsidian YAML frontmatter | ✅ 已支持（v0.4 新增，10 字段，YAML 合法） |
> | Dataview 检索友好 | ✅ 已支持（v0.4 新增，按 author / source / tags / mentioned_symbols 检索） |
> | 批量抓取 | ✅ 已支持（v0.5 新增，`--file urls.txt` 模式） |
> | 已抓过链接自动跳过 | ✅ 已支持（v0.5 新增，扫描 OUTPUT_DIR 里的 `.json` 文件判定） |
> | batch-log.json 输出 | ✅ 已支持（v0.5 新增，追加式记录每次批次的 items + 统计） |
> | **AI 总结层（可选）** | ✅ 已支持（v0.6 新增，`summary.enabled` 开关，LLM 失败不影响主流程） |
> | 字幕 | ❌ 暂不支持 |
> | 博主主页跟踪 | ❌ 暂不支持（ROADMAP 阶段四明确不做） |
> | LLM 总结（默认开启） | ❌ 默认关闭，需 `summary.enabled=true` |
> | 字幕自动展开 | ❌ 暂不支持（需手动点播放器字幕按钮） |

把单条抖音分享链接（短链或长链）抓成 Obsidian Markdown 笔记，落到 `D:\ObsidianVault\Douyin\` 下。

**核心原则**：
- 复用本机 Edge 的登录态（通过 CDP 9222 端口连过去），不重新登录
- **不下载视频**、**不抓 mp4**、**不读取 cookie**
- 只读取 DOM 文本（标题/作者/发布时间/章节/评论）

## 文件结构

```
douyin-link-to-obsidian/
├── index.js         # 主脚本
├── config.json      # 配置（路径/CDP/评论条数）
├── package.json
└── README.md
```

## 前置条件

- Windows 10/11 + WSL2
- WSL 里 Node.js + Playwright（已装好）
- Windows 侧 Microsoft Edge

## 三步启动

### 第 1 步：Windows 侧启动 Edge（带远程调试端口）

**用独立 user-data-dir**，不能和日常浏览的 Edge 混：

```powershell
# 打开 PowerShell（管理员或普通都行）
$dir = "$env:USERPROFILE\.hermes\edge-debug"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Start-Process "msedge.exe" `
  -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=$dir", "--no-first-run", "--no-default-browser-check"
```

**验证端口起来没**：

```powershell
curl http://127.0.0.1:9222/json/version
```

应该返回 `Browser: Edg/...` 的 JSON。

### 第 2 步：手动登录抖音

1. Edge 启动后**手动打开** `https://www.douyin.com`
2. 扫码或手机号登录
3. 登录态会自动保存到 `$dir` 这个 profile 下，下次启动同一个目录就还是已登录

> **不要**直接在 WSL 里跑脚本登录——抖音对 headless 浏览器的反爬很严，必须人工在真实 Edge 窗口里登录。

### 第 3 步：WSL 侧运行脚本

```bash
cd ~/douyin-link-to-obsidian
node index.js "https://v.douyin.com/2vX7spOC_sg/"
```

或者用 npm script：

```bash
npm run grab -- "https://v.douyin.com/2vX7spOC_sg/"
```

## 输出位置

`D:\ObsidianVault\Douyin\YYYY-MM-DD-博主名-标题.md`

示例：
```
D:\ObsidianVault\Douyin\2026-06-01-机构一手调研（福总）-韬定律刷屏之后，华为的突破真相与冷静思考.md
```

**文件名规则**：
- 日期：当天（按本机时区）
- 非法字符自动替换为 `-`（`\ / : * ? " < > |` 全部清洗）
- 连续空白/横线合并
- 截断到 80 字符
- 重名追加 `-HHMMSS` 时间戳

> **v0.3 新增**：每次抓取同时生成同名 `.json` 文件（与 `.md` 同目录）。结构化字段便于程序消费。
> jq 消费示例：
> ```bash
> jq -r '"\(.scraped_at) \(.author): \(.title)"' *.json
> jq -r '.mentioned_symbols[]? | "\(.kind): \(.value)"' *.json | sort -u
> ```

## JSON 输出字段（v0.3）

| 字段 | 类型 | 说明 |
|------|------|------|
| `source_name` | string | 固定 `"douyin"`（平台标识） |
| `source_level` | string | 固定 `"video"`（来源类型） |
| `source_url` | string | 用户输入的原始 URL（短链） |
| `final_url` | string | 跳转后的 URL（带 `video_id` 的长链） |
| `author` | string \| null | 视频作者 |
| `title` | string \| null | 视频标题 |
| `published_at` | string \| null | 发布时间（保持抖音原文本格式，不强行转 ISO） |
| `content_text` | string | 章节 + 热门评论拼成的纯文本描述（v0.3 没有正文文案时的替身） |
| `chapters` | string[] | 章节列表（HH:MM 开头） |
| `comments` | object[] | 评论列表，每条含 `user` / `time` / `likes` / `text` |
| `mentioned_symbols` | object[] | 提及的股票，`{kind, value}` 结构 |
| `scraped_at` | string (ISO) | 抓取完成时间 |
| `raw_payload` | object | 原始抓取数据（`video_id` + `stats`）；不含 cookie / mp4 URL |
| `failure_log` | object[] | 失败原因汇总（reason / detail / at） |

**`mentioned_symbols` 提取策略**（v0.3 轻量版，不调 LLM）：
1. 静态词典匹配（`KNOWN_A_STOCKS` 数组里的中文股票名）
2. A 股代码正则 `\b[036]\d{5}\b`（以 0/3/6 开头避免误匹）
3. 港股代码正则 `\b\d{4,5}\.HK\b`

## Markdown Frontmatter 字段（v0.4）

每个 `.md` 文件顶部带 YAML frontmatter（10 字段），Obsidian 原生识别 + Dataview 可直接查询：

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | string | 视频标题 |
| `author` | string | 视频作者 |
| `source` | string | 固定 `"douyin"`（来源平台） |
| `source_url` | string | 用户输入的原始 URL（短链） |
| `final_url` | string | 跳转后的 URL（长链） |
| `published_at` | string | 发布时间（抖音原文本格式） |
| `video_id` | string | 抖音视频 ID |
| `scraped_at` | string (ISO) | 抓取完成时间 |
| `mentioned_symbols` | object[] | 提及的股票 `[{kind, value}]` |
| `tags` | string[] | 标签（`douyin`, `抖音` + `stock/股票名` 形式） |

**Dataview 查询示例**：

```dataview
TABLE author, published_at, length(tags) - 2 AS "提及股票数"
FROM "Douyin"
WHERE source = "douyin"
SORT published_at DESC
```

```dataview
LIST
FROM "Douyin"
WHERE contains(tags, "stock/长电科技")
```

```dataview
TABLE author, published_at
FROM "Douyin"
WHERE mentioned_symbols[*].value = "中芯国际"
FLATTEN mentioned_symbols
```

**示例 frontmatter**（实际抓取输出）：
```yaml
---
title: 韬定律刷屏之后，华为的突破真相与冷静思考#韬定律#半导体#芯片#国产算力#科创板
author: 机构一手调研（福总）
source: douyin
source_url: https://v.douyin.com/2vX7spOC_sg/
final_url: https://www.douyin.com/video/7644012348403992037
published_at: 2026-05-26 09:51
video_id: "7644012348403992037"
scraped_at: 2026-06-01T08:05:43.551Z
mentioned_symbols:
  - kind: a_stock_name
    value: 长电科技
  - kind: a_stock_name
    value: 深科技
  - kind: a_stock_name
    value: 太极实业
  - kind: a_stock_name
    value: 利通电子
  - kind: a_stock_name
    value: 盛合晶微
  - kind: a_stock_name
    value: 中芯国际
  - kind: a_stock_name
    value: 华为
  - kind: a_stock_name
    value: 昇腾
tags: [douyin, 抖音, stock/长电科技, stock/深科技, stock/太极实业, stock/利通电子, stock/盛合晶微, stock/中芯国际, stock/华为, stock/昇腾]
---
```

## 批量抓取（v0.5）

### 用法

```bash
# 准备 urls.txt（每行一条 URL，# 开头是注释，空行被忽略）
cat > urls.txt <<'EOF'
# 韬定律专题
https://v.douyin.com/2vX7spOC_sg/
https://www.douyin.com/shipin/7644729891430336512
EOF

# 跑
node index.js --file urls.txt
```

### 行为

| 行为 | 说明 |
|------|------|
| 单条失败不影响后续 | 每条 URL 独立 try/catch，失败后下一条继续 |
| 已抓过链接跳过 | 扫 `OUTPUT_DIR` 里所有 `.json` 的 `source_url` / `final_url`，匹配到就 skip |
| 章节之间间隔 1 秒 | 防抖音反爬（不会瞬时大量请求） |
| 生成 `batch-log.json` | 追加式记录每个批次（不覆盖历史），含 items + 统计 |
| 非 douyin.com URL | 整批过滤前会 warn，跳过无效行 |
| `zhuanti/` 等非视频页 | 抓"全空"但仍写文件（继承 v0.1 单条行为，**算 success**，failure_log 有记录） |
| exit code | 0 = 全部 success 或 skipped；1 = 有 failed |

### batch-log.json 格式

```json
{
  "batches": [
    {
      "batch_started_at": "2026-06-01T08:29:48.581Z",
      "batch_finished_at": "2026-06-01T08:30:57.417Z",
      "total": 10,
      "success": 8,
      "skipped": 2,
      "failed": 0,
      "items": [
        {"url": "https://...", "status": "skipped", "reason": "已抓过 (匹配文件: ...)", "elapsed_ms": 7},
        {"url": "https://...", "status": "success", "file": "...md", "json_file": "...json", "elapsed_ms": 7844}
      ]
    }
  ]
}
```

**消费示例**（jq）：
```bash
# 看最近一次批次的失败项
jq '.batches[-1].items[] | select(.status == "failed")' batch-log.json

# 累计总成功/失败
jq '[.batches[].success] | add' batch-log.json

# 找所有批次的 skipped 项
jq '.batches[].items[] | select(.status == "skipped") | .reason' batch-log.json
```

## AI 总结层（v0.6，可选）

### 用法

在 `config.json` 里设 `summary.enabled: true`：

```json
{
  ...,
  "summary": {
    "enabled": true,
    "provider": "minimax-cn",
    "model": "MiniMax-M2.7",
    "base_url": "https://api.minimaxi.com/anthropic",
    "max_tokens": 1024,
    "timeout_ms": 30000
  }
}
```

环境变量需要任一 `MINIMAX_CN_KEY` / `HERMES_MINIMAX_KEY` / `ANTHROPIC_API_KEY`。

### 行为契约

| 场景 | 行为 |
|------|------|
| `enabled=false` | 完全不调 LLM，`summary` 字段为 null |
| `enabled=true` + 有 key + LLM 成功 | 调 LLM，5 字段写入 `data.summary`，**重写** .md/.json（追加 AI 总结段） |
| `enabled=true` + 无 key | warn "未找到 API key"，跳过，文件保留原始内容 |
| `enabled=true` + 网络错/超时/JSON 错 | warn "AI 总结失败"，**主流程不受影响**，文件保留原始内容 |
| `enabled=true` + LLM 成功 | 5 字段：`viewpoints` / `risks` / `mentioned_symbols` / `follow_ups` / `replicable_takeaways` |

### 不覆盖原始内容

v0.6 写入策略：
1. **先生成**原始 .md + .json（不带 summary）
2. **再调** LLM（不影响主流程）
3. **只在 LLM 成功时**把 summary 注入 data 并**重写**两个文件（追加 AI 总结段到末尾）

原始 frontmatter / 元数据表 / 章节 / 评论 / 抓取日志**全程不被修改**。

### JSON 字段

```json
{
  ...其他字段...,
  "summary": {
    "viewpoints": ["...", "..."],
    "risks": ["..."],
    "mentioned_symbols": [{"kind": "a_stock_name", "value": "..."}],
    "follow_ups": ["..."],
    "replicable_takeaways": ["..."],
    "_meta": {
      "provider": "minimax-cn",
      "model": "MiniMax-M2.7",
      "generated_at": "2026-06-01T..."
    }
  }
}
```

### 已知限制

- **WSL 环境下 Node 的 `fetch()` 不走 `HTTPS_PROXY` 环境变量**——如果你 WSL 里配了代理（`HTTPS_PROXY=http://127.0.0.1:7897`），LLM 调用仍会失败（`fetch failed` / 超时）。解决方案：
  1. 在 Windows PowerShell 跑脚本（不走 WSL 代理）
  2. 等 v0.7 增加 undici ProxyAgent 支持（v0.6 范围外）
- API key 必须**有 Anthropic-compatible 端点权限**（MiniMax CN 默认走 `/anthropic/v1/messages`）

## 配置项（config.json）

```json
{
  "obsidian": {
    "output_dir": "/mnt/d/ObsidianVault/Douyin"
  },
  "browser": {
    "cdp_url": "http://127.0.0.1:9222",
    "goto_timeout_ms": 30000,
    "wait_after_navigate_ms": 3000,
    "wait_after_scroll_ms": 2000
  },
  "scrape": {
    "fetch_comments": true,
    "comment_max_count": 10
  }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `obsidian.output_dir` | `/mnt/d/ObsidianVault/Douyin` | 笔记输出目录（WSL 路径写法） |
| `browser.cdp_url` | `http://127.0.0.1:9222` | Edge 远程调试端口（WSL 走 127.0.0.1 通本机） |
| `browser.goto_timeout_ms` | `30000` | 页面加载超时 |
| `browser.wait_after_navigate_ms` | `3000` | 跳转后等 DOM 稳定 |
| `browser.wait_after_scroll_ms` | `2000` | 滚动后等评论懒加载 |
| `scrape.fetch_comments` | `true` | 是否抓评论（关闭后整段跳过） |
| `scrape.comment_max_count` | `10` | 最多抓多少条评论 |

## 抓取内容

| 字段 | 来源 | 状态 |
|------|------|------|
| 标题 | `[data-e2e="detail-video-info"]` 内的 h1 | ✓ |
| 作者 | "作者"标签附近的 `a[href*="/user/"]` | ✓ |
| 发布时间 | `[data-e2e="detail-video-publish-time"]` | ✓ |
| 章节列表 | 文本匹配 `HH:MM + 标题` | ✓ |
| 评论（点赞/时间/正文） | `[class*="comment-mainContent"]`（需 scroll 触发） | ✓ |
| 互动数据（点赞/评论/收藏/分享） | 文本数字 | ✓（原始顺序，未语义化） |
| 视频文案 | 抖音 PC 版**未在 DOM 暴露独立容器** | ✗ 未抓 |
| 字幕 | 视频默认静音，字幕面板需手动展开 | ✗ 未抓 |
| mp4 文件 | — | ✗ 不抓（按要求） |
| cookie | — | ✗ 不读（按要求） |

## 失败处理

脚本在以下情况会**生成笔记但标注"未知/未获取"**（不中断）：
- 标题/作者/发布时间 全空（可能反爬或登录失效）
- 章节为空
- 评论为空（可能未登录）
- 字幕永远为"未获取"

脚本在以下情况会**直接报错退出**：
- 链接不含 `douyin.com`
- CDP 9222 端口不通
- 浏览器未启动或被关闭

每条失败原因会汇总到 stderr 末尾，例：

```
========== 失败原因汇总 ==========
1. [2026-06-01T13:45:21] CDP 端口不可达
   详情: fetch failed, 请确认 Edge 已用 --remote-debugging-port=9222 启动
====================================
```

## 已知坑

1. **抖音 PC 版 DOM 不稳定**：class 名是 hash 化的（`B7xjsf10` / `pZwkOJ8K` 这种），未来抖音改版可能失效。优先用 `data-e2e` 属性，class 只作 fallback。
2. **作者信息位置诡异**：抖音 PC 版把"作者卡片"放在 `data-e2e="related-video"` 节点里，名字旁边还紧跟推荐视频列表——DOM 抓取时容易误抓推荐区。**修复后**用"祖先节点含 '粉丝' + 数字"特征定位（不依赖具体文本/class 名）。
3. **评论懒加载**：必须 scroll 到页面底部才触发评论 DOM 渲染。**修复后**用"含 '回复' + '分享' + 数字赞数"的最小重复 DOM 块定位，并用祖先-后代表达式 dedup 掉外层容器。
4. ~~**章节列表**识别靠 `HH:MM` 正则——如果抖音改用按钮形式（点开才显示），这个会失效。~~ **v0.2 已修复**：改为"自适应稳定等待"，每 500ms 探测一次，连续 2 次相同章节数即返回（最多 10 秒）。章节数现在 100% 可复现。
5. **短链 302**：抖音短链 `v.douyin.com/xxx` 会 302 到 `www.douyin.com/video/数字ID`，自动 follow 即可。**v0.2 已记录**：`original_url`（用户输入） + `final_url`（跳转后）分别写入 frontmatter 和元数据表。
6. **9292 端口不能和正常 Edge 共享**：必须用独立 `--user-data-dir`，否则 `Start-Process` 会拉不起新进程（端口被占用）。
7. ~~**`/shipin/` 类型 URL 的发布时间抓不到**~~ **v0.2 已修复**：`/video/` 用 `data-e2e="detail-video-publish-time"`，`/shipin/` 兜底用全文正则 `发布时间[：:]\s*\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}`。两种 URL 形式现在都能抓到发布时间。
8. **重试策略范围有限**：v0.2 失败重试只对**网络/CDP/导航类错误**生效，selector 失败不重试（重试 selector 失败没有意义）。如果遇到 selector 失效，是代码 bug，需要修 selector 而不是重试。

## 调试技巧

**不开 Edge 也能测试脚本基本结构**（不抓数据，但能看配置是否加载正确）：

```bash
cd ~/douyin-link-to-obsidian
node -e "const c = require('./config.json'); console.log(JSON.stringify(c, null, 2))"
```

**想看 DOM 抓取时具体拿到了什么**，可以在 `scrapeDouyinPage` 的 evaluate 里加：

```js
return { raw: { 
  bodyTextSample: document.body.innerText.slice(0, 1000),
  videoInfoContainer: document.querySelector('[data-e2e="detail-video-info"]')?.outerHTML.slice(0, 2000)
}};
```

## 验收对照

按你给的需求逐条对照：

| 需求 | 实现位置 |
|------|---------|
| ① 连接 127.0.0.1:9222 本机 Edge CDP | `connectBrowser()` + `chromium.connectOverCDP` |
| ② 输入单条抖音 URL | `process.argv[2]` |
| ③ 输出到 `D:\ObsidianVault\Douyin\` | `OUTPUT_DIR` + WSL 路径 `/mnt/d/ObsidianVault/Douyin` |
| ④ 文件名自动清洗非法字符 | `sanitizeFilename()` |
| ⑤ 抓取失败时输出失败原因和抓取日志 | `FAILURE_LOG[]` + 末尾汇总输出 |
| ⑥ 不抓 mp4 / 不下载 / 不读 cookie | 全程不调用 `page.video` / 不 fetch 媒体 URL / 不调用 `context.cookies()` |
| ⑦ 配置项集中到 config.json | `CONFIG` 对象从 `config.json` 加载 |
| ⑧ README 写清启动/登录/运行命令 | 本文档 |
| ⑨ Hermes cdp_url 恢复为空 + 重启 gateway | 临时改动，任务完成后已还原（见 git log / config 备份） |
