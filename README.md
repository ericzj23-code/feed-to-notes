# douyin-link-to-obsidian

> **当前能力边界**（v0.1 标签对应 `ef24ae7`）
>
> | 项 | 状态 |
> |---|---|
> | 单条抖音 URL 抓取 | ✅ 已支持（短链 `v.douyin.com/xxx` + 长链 `www.douyin.com/video/数字ID`） |
> | 标题 | ✅ 已支持 |
> | 作者 | ✅ 已支持 |
> | 发布时间 | ⚠️ 仅 `/video/` 路径支持；`/shipin/` 路径存在已知问题（见 #7） |
> | 章节 / 文案 | ⚠️ 章节已支持但非稳态（懒加载，详见 #4） |
> | 评论 | ✅ 已支持（默认 10 条，可配置） |
> | 抓取日志 | ✅ 已支持（写入 md 文件 + 控制台输出） |
> | 字幕 | ❌ 暂不支持 |
> | 博主主页跟踪 | ❌ 暂不支持 |
> | 批量抓取 | ❌ 暂不支持 |
> | LLM 总结 | ❌ 暂不支持 |
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
4. **章节列表**识别靠 `HH:MM` 正则——如果抖音改用按钮形式（点开才显示），这个会失效。**已知非稳态**：同一 URL 多次跑章节数 1/7/25 浮动，根因是章节是懒加载、`wait_after_navigate_ms`（默认 3000ms）不够。等时机成熟扩展等待时间。
5. **短链 302**：抖音短链 `v.douyin.com/xxx` 会 302 到 `www.douyin.com/video/数字ID`，自动 follow 即可。
6. **9292 端口不能和正常 Edge 共享**：必须用独立 `--user-data-dir`，否则 `Start-Process` 会拉不起新进程（端口被占用）。
7. **`/shipin/` 类型 URL 的发布时间抓不到**：当前实现只支持 `/video/` 路径下的 `[data-e2e="detail-video-publish-time"]` 元素。`/shipin/` 是抖音另一种重定向后的 URL 形式，发布时间用不同的 DOM 结构展示，需要单独写 selector。已知未修复。

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
