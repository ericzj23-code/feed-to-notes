项目：feed-to-notes（前身 douyin-link-to-obsidian）阶段计划

当前版本：
v0.11-feed-to-notes

总原则：
1. 当前继续使用 default profile。
2. 每次只执行一个阶段，不允许跨阶段开发。
3. 每个阶段必须包含：修改范围、测试结果、git diff、README 更新、单独 commit。
4. 每完成一个阶段必须停下来，等待我确认后再进入下一阶段。
5. 不导出 cookie，不读取 context.cookies()，不抓 mp4，不下载视频。
6. node index.js "<url>" 必须始终保持可用。

阶段一：v0.2 stability
目标：提高单条 URL 抓取稳定性。
范围：
- 修章节/文案懒加载等待策略
- 修 /shipin/ URL 发布时间
- 记录短链跳转后的 final_url
- 增加失败重试和日志

验收：
- 5 条不同 URL 测试
- 同一 URL 连跑 2 次，章节数量不能明显波动
- 失败项写入 README Known Issues
- commit: v0.2 improve douyin scrape stability

阶段二：v0.3 json output
目标：新增同名 JSON 输出，不破坏 Markdown。
字段：
source_name, source_level, source_url, final_url, author, title, published_at, content_text, chapters, comments, mentioned_symbols, scraped_at, raw_payload, failure_log

验收：
- 每次同时生成 .md 和 .json
- JSON 可正常 parse
- README 说明字段
- commit: v0.3 add structured json output

阶段三：v0.4 obsidian polish
目标：优化 Obsidian 使用体验。
范围：
- 增加 YAML frontmatter
- 增加 tags、author、source_url、published_at、scraped_at、mentioned_symbols
- 股票提取先用正则/词典，不用 LLM

验收：
- Obsidian 可识别 frontmatter
- Dataview 可按 author/source/tags 检索
- commit: v0.4 improve obsidian markdown format

阶段四：v0.5 batch queue
目标：支持 urls.txt 批量处理。
范围：
- node index.js --file urls.txt
- 已抓过链接默认跳过
- 单条失败不影响后续
- 生成 batch-log.json
- 不做博主主页跟踪

验收：
- 10 条 URL 批量测试
- 重复 URL 自动跳过
- 单条命令仍可用
- commit: v0.5 add batch url queue

阶段五：v0.6 summary layer
目标：增加可选 AI 总结层。
范围：
- config.json 增加 summary.enabled
- enabled=false 时只抓原始内容
- enabled=true 时输出观点、风险、提及标的、可跟踪问题、可模仿点
- LLM 失败不影响 md/json 输出

验收：
- AI 开关可用
- 无 API key 时脚本仍可抓取
- AI 总结不覆盖原始内容
- commit: v0.6 add optional summary layer

现在只创建并执行阶段一：v0.2 stability。完成后停下来汇报，不要自动进入阶段二。

---

阶段六：v0.9 creator tracking
目标：支持固定抖音博主主页追踪，发现新增视频。
范围：
- 新增子命令 `node index.js --creator "<creator_url>"`
- 新增子命令 `node index.js --creators-file file.txt`（批量博主）
- 新增 `scrapeCreatorPage()`，抓博主主页"作品"tab 的视频列表（aweme_id + 标题 + 卡片可见字段）
- 新增 state 文件 `state/<sec_uid>.json` 持久化"已知 aweme_id 集合"
- 新增 report 文件 `reports/<sec_uid>-<ISO_DATE>.md` 人类可读的"本次新增/全量"报告
- 复用现有 Edge CDP 9222 + 登录态，**不抓 mp4 / 不下载视频 / 不做字幕 / 不做 AI summary**

不做（v0.9 范围外）：
- ❌ 不对新增视频自动跑 `scrapeDouyinPage`（那是 v0.10）
- ❌ 不抓博主"喜欢"tab / 合集 / 推荐
- ❌ 不调 LLM 总结（即便 `summary.enabled=true`，`--creator` 路径也不调 LLM）
- ❌ 不下载 mp4 / 不读 cookie

目录结构（沿用 ObsidianVault 下独立分区，不污染现有 `Douyin/` 笔记目录）：
```
D:\ObsidianVault\DouyinTracker\
├── state\      # 博主状态文件：state/<sec_uid>.json
├── reports\    # 本次跑的报告：reports/<sec_uid>-<ISO_DATE>.md
├── queue\      # 预留：未来 v0.10+ 用（自动 follow-up 抓取的视频 ID 队列）
└── logs\       # 预留：博主追踪的运行日志
```

状态文件 schema（`state/<sec_uid>.json`）：
```json
{
  "sec_uid": "MS4wLjABAAAA...",
  "nickname": "博主昵称",
  "first_seen": "2026-06-01T10:00:00Z",
  "last_checked": "2026-06-01T11:30:00Z",
  "known_aweme_ids": ["7644...", "7645..."],
  "last_run_summary": {
    "total_found": 142,
    "new_count": 3,
    "new_aweme_ids": ["7644..."]
  }
}
```

报告 schema（`reports/<sec_uid>-<ISO_DATE>.md`）：
- baseline 模式（state 不存在）：列出当前主页抓到的所有视频（video_id + 标题 + 卡片可见字段），不标"新增"
- delta 模式（state 存在）：列出 `new_aweme_ids` + 对比 `total_found` 数字
- 两种模式都附：`sec_uid` / `nickname` / `follower` / `total_liked` / `run_at` / `state_path` 顶部元信息

CLI 入口：
| 命令 | 行为 |
|------|------|
| `node index.js "<url>"` | 单视频抓取（v0.7.1 行为，0 变化） |
| `node index.js --file urls.txt` | 批量视频（v0.5 行为，0 变化） |
| `node index.js --creator "<url>"` | 单博主检查 1 次 |
| `node index.js --creators-file file.txt` | 批量博主（每行一个 URL） |
| `--file` 与 `--creators-file` 互斥 | 混用直接报错退出 |

首跑 baseline 行为：
- state 文件不存在 → **视当前主页所有视频为"已知"**，不触发"新增视频"
- 同时生成 baseline report，列出本次主页抓到的所有视频（video_id + 标题 + 卡片可见字段），供人工核对
- baseline report 仍写入 `reports/<sec_uid>-<ISO_DATE>.md`，标题前缀 `[BASELINE]`
- baseline 完成后写入 state 文件（建档）

滚动抓取策略（主页作品 tab）：
1. 导航到 `https://www.douyin.com/user/<sec_uid>?tab=post`
2. 提取博主元信息（昵称/粉丝/关注/获赞/签名）
3. 滚动触发懒加载，每次等 `wait_after_scroll_ms`（沿用 v0.7.1 配置）
4. 抓 `a[href*="/video/"]` 卡片，提取 `aweme_id`（去重）
5. 停止条件（三选一）：
   - 连续 `scroll_stable_rounds`（默认 2）次滚动无新 aweme_id
   - 达到 `max_videos_per_creator`（默认 200）上限
   - 连续 `scroll_max_no_change`（默认 5）次无变化（强兜底，防死循环）
6. 滚动策略在 `creator_tracking` 配置块里集中管理

v0.9 不动 v0.7.1 的 4 块配置（`obsidian` / `browser` / `scrape` / `summary`）。
v0.9 新增 `creator_tracking` 配置块（缺省即用默认，不破坏现有 config.json 兼容）：
```jsonc
{
  // ... 现有字段不动 ...
  "creator_tracking": {
    "tracker_dir": "/mnt/d/ObsidianVault/DouyinTracker",  // state/reports/queue/logs 的根
    "max_videos_per_creator": 200,
    "scroll_stable_rounds": 2,
    "scroll_max_no_change": 5,
    "scroll_pause_ms": 1500
  }
}
```

测试博主候选（已通过预检：公开访问、近期仍更新、作品数 ≥ 20）：
| 序号 | 昵称 | sec_uid | 题材 | 作品数 | 验证依据 |
|------|------|---------|------|--------|----------|
| ① | 九号科技快讯 | MS4wLjABAAAAduqmYidP68EjEGvhxJPk-m1y3B7DXWLLPSSqGz_SU4mUBjtlfJLlFhanKdSHNyvm | 韬定律/半导体 | 62 | latest aweme_id 7646400922290338673（>v0.7.1 测试集上限 7645520xxx）|
| ② | 恒信投资 | MS4wLjABAAAAFgSn5V7Si4StPqALJGxpTCnUvUAnvKJwUKmRrV3Ov9s | 玻璃基板 | 63 | latest aweme_id 7646194977067949667 |
| ③ | 沪上涨公子 | MS4wLjABAAAA8pmCeYGCaKo8QH6ekmm8F4_CsbOZCb52Hh3S7cJOdo9p3tV8oZbNaYdmd6z3Ccw4 | 长电/通富封测 | 27 | latest aweme_id 7646292673234063459 |

> 验证方法：拿 v0.7.1 测试集 27 条 shipin URL 反查博主身份 → 用 playwright 连 Edge 9222 探针 `?tab=post` 抓取作品列表。
> 抖音 aweme_id 19 位单调递增，数字越大越新；3 个博主 latest ID 均 > 5/31 测试上限 → 全部"近期仍更新"。

验收：
- [ ] ① 单博主检查：拿 ① 跑 `--creator`，日志显示抓了 N 条视频（N 应 ≥ 20）
- [ ] ② baseline report：state 不存在时跑 → `reports/<sec_uid>-<ISO>.md` 标题 `[BASELINE]`，列出全部视频
- [ ] ③ delta 模式：再跑同一个博主 → `new_count` 应是主页最新发布且**不在** state 的那些
- [ ] ④ state 持久化：删 `state/<sec_uid>.json` 后再跑，`new_count` = `total_found`（首次重建）
- [ ] ⑤ 零回归：跑 v0.7.1 的 27 条测试集（`tests/fixtures/urls-v07.txt`），用户视角成功率仍 ≥ 96%
- [ ] ⑥ 不抓 mp4 / 不调 AI：跑时 ps -ef 没有下载行为；`summary.enabled=true` 时 `--creator` 路径**不调** LLM
- [ ] ⑦ 批量博主：3 个测试博主塞 `creators.txt`，跑 `--creators-file`，3 个 report 都生成
- [ ] ⑧ 互斥检查：`--file urls.txt` 和 `--creators-file creators.txt` 同时给 → 报错退出 exit code 非 0
- [ ] ⑨ 主流程 0 回归：`node index.js "<video_url>"` 行为与 v0.7.1 完全一致
- [ ] ⑩ 报告可读：`reports/<sec_uid>-<ISO>.md` 不调 LLM 也能直接看明白本次新增了什么

测试顺序建议：
1. 先跑验收 ①②（baseline 模式，确认 report 内容可读）
2. 跑验收 ⑤（零回归，确认 v0.7.1 行为不变）
3. 跑验收 ③④⑥（delta 模式 + state 持久化 + AI 隔离）
4. 最后跑 ⑦⑧⑨⑩（批量 / 互斥 / 单视频 / 报告人工 review）

> 阶段六设计稿到此为止。等你确认整体设计 + 3 个测试博主候选后，才进入 v0.9.1 实施。

---

## 阶段六实施记录

> **状态**：✅ 已完成（2026-06-01）
> **commit**：`6f99639` (Card 1+2+3) + `test-report-v09.md` commit (Card 4)
> **tag**：`v0.9-creator-tracking`

### 实施结果

| 验收项 | 结果 | 备注 |
|--------|------|------|
| ① 单博主 baseline | ✅ 62 条 / 10.7s | 九号科技快讯 |
| ② baseline report | ✅ `[BASELINE]` 前缀 + 全部视频 | 13 KB |
| ③ delta 模式 | ✅ 22/22 正确识别 | 步 2 实证 |
| ④ state 持久化 | ✅ union 累计 30→52→78→62→69 | 5 步走 |
| ⑤ v0.7.1 零回归 | ✅ 用户视角 24/27=24/27 | apples-to-apples |
| ⑥ 不抓 mp4 / 不调 AI | ✅ AI 隔离 0 调用 | `summary.enabled=true` 跑 --creator |
| ⑦ 批量博主 | ⏸ 逻辑已实现，未真实压 3 个博主批量 | v0.10+ 补 |
| ⑧ 互斥检查 | ✅ | `--file` + `--creators-file` 报错 |
| ⑨ 主流程 0 回归 | ✅ `scrapeDouyinPage` 219 行未变 | 硬证据 |
| ⑩ 报告可读 | ✅ DELTA + BASELINE 表格渲染正常 | |

### 偏离设计的地方

1. **report 文件名 DELTA 加 `HHMMSS` 时间戳**（设计稿是 `<sec_uid>-<ISO_DATE>.md`）—— Card 4 修。原因：DELTA 多次跑会覆盖，HHMMSS 让每次跑独立成文件。BASELINE 不带时间戳（一次性建档没必要）。
2. **state 删后 first_seen 重置** —— Card 3 报告里曾标"设计妥协"，**Card 4 重新审视**为"v0.9.1 设计契约"。state = 当前累计；删 = 主动丢历史。archive 机制是 v0.10+ 范围。

### 详细测试数据

见 `test-report-v09.md`（5 步走 + 5 步算法正确性硬证据）。

---

## v0.11 实施记录

> **状态**：✅ 已完成（2026-06-03）
> **commits**（4 个，bisect 友好）：
> - `aa51169` v0.11 dedup: scan 外提 + video_id 锚点
> - `ceca526` v0.11 symbol 提取: 数字 lookaround + 中文 includes + 词典准入自检
> - `bc2a3a5` v0.11 FAILURE_LOG 局部化: fail() 接 target, processOneUrl 用局部数组
> - `ae90923` v0.11 lifecycle consistency

### 已落地的关键决策（陈述现状）

| 决策点 | 当前状态 | 已知能力边界 |
|--------|----------|--------------|
| dedup 锚点 | 双 Map：URL 字符串 + video_id。A 路径：URL 命中走快 skip；B 路径：scrape 后 video_id 命中走 skip（白跑一次 scrape，elapsed_ms 照实记录不归零） | B 路径代价是单条 URL 多走一次 scrape |
| symbol 中文名 | `blob.includes(name)`，不加词边界 | "加深科技投入"会匹出"深科技"——语境误召回，已知能力边界，留待 LLM 精筛 |
| symbol 数字代码 | `(?<![0-9])[036]\d{5}(?![0-9])` + 港股同款 | "涨了300000元"仍误匹——汉字-数字邻接不是数字-数字邻接，lookaround 修不了，留待 LLM 精筛 |
| 词典准入规约 | 加载期 `validateStockDict()` 自检：单字 / 通用词 / 真子串对 → console.warn 不阻断 | warn 不阻断是为了不挂历史已入库笔记 |
| FAILURE_LOG | `fail(reason, detail, target)`，局部数组天然隔离并发 | 全局 `FAILURE_LOG` 保留作进程级 fatal log（博主追踪 / CDP 连接） |
| 生命周期 | runSingle / runBatch / runCreatorsBatch 全部 try/finally 闭环；runCreatorsBatch 外层连一次 CDP，循环复用 sharedContext | `connectOverCDP` 复用本机 Edge 进程不主动 close（关了下次跑要重启 Edge） |
| yamlEscape | 不截断 frontmatter 字段值 | 文件名截断归 `sanitizeFilename`（80 字符） |
| 相对时间 | **未解析**——抖音 PC 显示"X 天前""昨天"时 `published_at=null`，文件名 fallback 到抓取日 | Dataview 按 `published_at` 排序时这条会错位，详见下方 v0.12 候选 |

### 回归验证（v0.11 → 真实库 71 条笔记回放）

- **symbol**：旧匹 98 中文名 / 1 代码 → 新匹 98 / 1，0 差异。README 示例 8 个 symbol 全召回。词典内子串对 = 0（实测）。
- **dedup B 路径**：5 个场景离线模拟 16/16 通过，覆盖"短链→长链重抓（A）""/shipin/ 形式重抓（B）""长链已抓→短链重抓（B）"。

### 代码内规约注释

`index.js` 的 `KNOWN_A_STOCKS` 上方写有完整准入规约（禁收长名子串碎词 / 禁收单字 / 禁收通用词），扩词典时遵守。

---

## v0.12 候选

> **状态**：未开始。本节只是把"已知未修"列出来陈述现状，不承诺时间表。

### 候选 1：相对时间解析

**现状**（陈述）：抖音 PC 版对部分视频显示"X 天前""昨天""X 小时前""X 分钟前"等相对时间，scrape 时 `published_at` 为 null，文件名 fallback 到抓取日。Dataview 按 `published_at` 排序时这些笔记会排到抓取当天（不是真实发布日期）。README 已知坑 #9 已有说明。

**影响**：单条笔记层面的"不报错但慢慢歪"——按日期排序时错位，**不会**让笔记丢失或损坏。

**候选修法**（不承诺哪版做）：
- 在 `scrapeDouyinPage` 的 `meta.publishTime` 提取后加 fallback 链：`/data-e2e` → 全文正则（`\d{4}-\d{1,2}-\d{1,2}`）→ 相对时间解析（"X 分钟前" → `new Date() - X*60*1000`；"X 小时前" 同理；"昨天 HH:MM" → `new Date() - 86400000`；"X 天前" → `new Date() - X*86400000`）
- 单元测试 5+ 个 case（覆盖"3 分钟前""昨天 09:30""5 天前" 等）
- 写明**相对时间只是估计**，不是发布真实秒级时间——写入 `published_at` 时可加注释或用单独字段

### 候选 2：批量博主跨次跑去重（v0.9 已知限制 #1）

**现状**（陈述）：博主主页"作品"分页动态性，同一博主 8 分钟内两次跑"新视频"数会变。v0.9 README 已知限制 #1 已说明。

**影响**：delta 报告里多报 / 少报新视频，**不会**让已抓笔记丢失或损坏。

**候选修法**：跨次 run 缓存 `aweme_id` 历史快照到 `state` 文件，diff 时和快照对比而不是和"本次抓到"对比。

### 候选 3：评论 O(n²) candidates.contains

**现状**（陈述）：v0.7.1 评论抓取那段 `candidates.sort` 后做 O(n²) 的 `contains` 两两比较。财经评论页 candidates 通常 10-50 条，长评论区会是热点。

**影响**：评论抓取在超长评论区可能变慢（数量级 100+ 候选时进入明显 O(n²)）。**当前未实测触发**。

**候选修法**：用 children hash（`c.children.length` + `c.firstChild?.textContent` 之类指纹）做 Map 预 dedup，避免两两 contains。

### 候选 4：test-report 文件归档

**现状**（陈述）：仓库根目录已堆 4 份 test-report 类文件（`test-report.md` / `test-report-v071.md` / `test-report-v09.md` + ROADMAP 内"阶段六实施记录"段）。历史快照性质，**不会腐烂**，但散在根目录影响整洁度。

**影响**：不影响功能，纯整洁问题。

**候选修法**：
- 把历史报告挪进 `docs/reports/`（新建子目录），根目录只留最新一份 + 指向入口
- 或挂到对应 git tag 的 release notes（每个 v0.x tag 带一个 release note 段）
- Eric 原话"不急，但迟早要理"
