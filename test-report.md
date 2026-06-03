# v0.7 Quality Baseline Test Report

> **测试版本**: v0.6-summary-layer (commit 5c7303a)
> **测试时间**: 2026-06-01 17:09:05 ~ 17:13:04 (Asia/Shanghai)
> **总耗时**: 238.4s
> **测试者**: Hermes (Eric 委托)
>
> **状态（v0.11 回看）**：本报告基于 v0.6，所列 P0/P1（`/shipin/` 路径 `video_id` 匹不到、长视频页 `detail-video-info` 失效、章节误匹播放器控件）已在后续版本修复。详见 README 已知坑 #7（`/shipin/` 发布时间 v0.2 已修）和 `index.js` 内 `scrapeDouyinPage`（`match(/\/(?:video|shipin)\/(\d+)/)`）、`waitForChapterStability`（`PLAYER_CONTROL_KEYWORDS` 黑名单）。保留作历史基线记录——bug 根因分析、字段成功率、修复方向这些是讲代码的，不随版本腐烂。

---

## 测试规模

| 维度 | 数量 |
|------|------|
| urls.txt 有效 URL 总数 | 27 |
| 短链 `v.douyin.com/` | 1 |
| `/shipin/` 长链 | 20 |
| `/video/` 长链 | 6 |
| 无效 URL（应被过滤） | 1（`youtube.com`） |
| 注释/空行 | 多条（应被忽略） |
| 不同博主覆盖 | 16+（财经/半导体/封测方向） |
| 长视频（>10 分钟） | 多条 |

## 端到端成功率

| 口径 | 结果 |
|------|------|
| v0.5/v0.6 批量脚本视角（写盘即 success） | 27/27 = 100% |
| **用户视角（标题/作者/发布时间至少一项非空才算实质成功）** | **25/27 = 92.6%** |
| 实质失败（关键字段全空） | 2/27 = 7.4% |

## 字段级成功率

| 字段 | 成功率 | 失败数 |
|------|--------|--------|
| **title** | 25/27 = 92.6% | 2 |
| **author** | 25/27 = 92.6% | 2 |
| **published_at** | 25/27 = 92.6% | 2 |
| **chapters** | 26/27 = 96.3% | 1 |
| **comments** | 25/27 = 92.6% | 2 |
| **JSON 解析** | 27/27 = 100% | 0 |
| **AI 总结** | 0/27 = 0% (默认 enabled=false，预期) | — |

> **AI 总结 = 0% 不是 bug**：v0.6 的 `summary.enabled` 默认是 `false`，不调 LLM。如需打开，改 `config.json` 即可。但 WSL 环境下 Node `fetch()` 不走 `HTTPS_PROXY`，实际可用性受限于代理配置（详见 v0.6 README）。

## 性能

| 指标 | 数值 |
|------|------|
| 总耗时 | 238.4s (3min 58s) |
| 平均每条（非 skipped） | 7.9s |
| 章节平均数 | 22 条 |
| 评论平均数 | 5 条 |
| 错误重试触发 | 0 次（首次全部成功） |
| 章节稳定等待超时 | 0 次 |

## 失败样本详情

> 失败样本 URL 与 video_id 已脱敏（用 `<id>` 占位）——根因是路径形态和 DOM 布局，不依赖具体某条视频。

### 失败样本 A: `/shipin/<id>` 长链

| 字段 | 值 |
|------|-----|
| URL 形态 | `https://www.douyin.com/shipin/<id>` |
| 类型 | 27 分钟长视频 |
| 标题 | **未抓到** |
| 作者 | **未抓到** |
| 发布时间 | **未抓到** |
| chapters | 0 |
| comments | 0 |
| **video_id** | **None**（**bug**：shipin 路径匹不到） |
| failure_log 原因 | 标题未抓到 / 作者未抓到 / 发布时间未抓到 / 评论未抓到 / 关键字段全空 |

**根本原因**：`video_id` 提取器只匹 `/video/(\d+)`，不匹 `/shipin/(\d+)`。脚本认为这是个新视频 / 重新抓取，但因为 `detail-video-info` 容器可能在长视频页有不同 DOM，导致 selector 全失效。

### 失败样本 B: `/video/<id>` 长链

| 字段 | 值 |
|------|-----|
| URL 形态 | `https://www.douyin.com/video/<id>` |
| 类型 | 17 分钟长视频 |
| 标题 | **未抓到** |
| 作者 | **未抓到** |
| 发布时间 | **未抓到** |
| chapters | 2（误匹播放器控件） |
| comments | 0 |
| video_id | `<id>`（匹到了） |
| failure_log 原因 | 标题未抓到 / 作者未抓到 / 发布时间未抓到 / 评论未抓到 / 关键字段全空 |

**根本原因**：`detail-video-info` 容器在长视频页不存在，疑似抖音的"图文视频"或"专栏"型布局使用不同 DOM 结构。

## 已知现象（不算 bug 但记下来）

1. **章节里含"因浏览器限制/当前为静音"等播放器控件**：是 HH:MM 正则误匹（本次 1-2 次出现）
2. **zhuanti/ 路径**：v0.5 测试时出现"全空但 success"（专题页结构），本次 urls.txt 未含 zhuanti URL
3. **WSL 代理**：v0.6 LLM 调用在 WSL 环境下受 `HTTPS_PROXY` 限制（不在 v0.7 范围）

## v0.7.1 Bugfix 建议（按优先级）

### P0 - 必修

**Bugfix #1**：`/shipin/` 路径的 `video_id` 提取器
- **位置**：`scrapeDouyinPage()` 里 `location.pathname.match(/\/video\/(\d+)/)`
- **问题**：只匹 `/video/(\d+)`，**不匹 `/shipin/(\d+)`**——导致 shipin 链接的 `video_id` 为 null，进一步让"已抓过"判定漏掉（同一视频 shipin 和 video 形式不互认）
- **影响范围**：所有 `/shipin/` 链接（本次 20 个，占 74%）
- **修复方向**：regex 改 `match(/\/(?:video|shipin)\/(\d+)/)`

### P1 - 重要

**Bugfix #2**：长视频页面（>10 分钟）的 `detail-video-info` selector 失效
- **位置**：`scrapeDouyinPage()` 主视频元数据 evaluate 块
- **问题**：少数 `/video/` 长视频页 `detail-video-info` 容器不存在，疑似抖音"图文视频"或"专栏"型布局
- **影响范围**：极少数（本次 1/27 = 3.7%）
- **修复方向**：检测 `detail-video-info` 不存在时，尝试降级 selector（`h1`、meta 标签、正文区域）

### P2 - 增强

**Bugfix #3**：章节误匹播放器控件
- **位置**：`waitForChapterStability()` 里的 `^\d{2}:\d{2}\s+\S` 正则
- **问题**：会匹到"00:00 因浏览器限制，当前为静音"这种 HH:MM 控件文字
- **影响范围**：几乎所有视频都可能出现（本次 1-2 次）
- **修复方向**：黑名单过滤含"因浏览器限制/当前为静音/倍速/智能/清屏/连播"等控件词的章节

### P3 - 可选

**Bugfix #4**：`summary` 字段即便 enabled=false 也写 `null` 占位
- **位置**：`buildJson()` 的 `summary: data.summary || null`
- **问题**：JSON 顶层 15 字段有 `summary: null` 字段，体积 + 视觉噪声
- **影响范围**：所有 27 个 .json
- **修复方向**：当 `data.summary == null` 时**整个字段不写**（用 `delete obj.summary`）

**Bugfix #5**：v0.6 LLM 调用在 WSL 下受代理限制
- **位置**：`callSummaryLLM()`
- **问题**：Node `fetch()` 不读 `HTTPS_PROXY` 环境变量
- **影响范围**：WSL 用户的 AI 总结功能
- **修复方向**：加 `undici.ProxyAgent` dispatcher（**需要新增 `undici` 依赖**——超出 v0.7 bugfix 范围，建议 v0.8 处理）

## v0.7 验收结论

**v0.6-summary-layer 在 27 条真实抖音 URL 测试中**：

- ✅ 基础稳定：27/27 全部成功生成 .md + .json
- ✅ 字段质量：title/author/published_at/chapters/comments 全部 >= 92%
- ✅ JSON 解析：100%
- ✅ batch 模式工作正常
- ✅ 失败降级：失败样本仍生成可读文件（untitled-untitled.md + 标注"未知"）

- ⚠️ 但存在 2 个 bug 需修：`/shipin/` 路径的 video_id 提取 + 长视频页的 selector 失效

**建议：进入 v0.7.1 修这 2 个 P0/P1 bug 后，再做一次 quality baseline 验证**。
