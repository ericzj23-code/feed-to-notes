项目：douyin-link-to-obsidian 阶段计划

当前版本：
v0.1-douyin-link-to-obsidian

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