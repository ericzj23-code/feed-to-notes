#!/usr/bin/env node
/**
 * douyin-link-to-obsidian
 * 输入：一条抖音分享链接
 * 输出：<obsidian.output_dir>/YYYY-MM-DD-博主名-标题.md
 *
 * 抓取策略：用本地 Edge/Chrome 的 CDP 会话（默认 127.0.0.1:9222）
 * 严格不抓 mp4、不下载视频、不读取 cookie
 *
 * 运行：node index.js "<douyin_url>"
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ============================================================
// 配置加载
// ============================================================
const CONFIG_PATH = path.join(__dirname, 'config.json');
let CONFIG;
try {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error(`[ERROR] 无法读取 config.json: ${e.message}`);
  process.exit(1);
}

const OUTPUT_DIR = CONFIG.obsidian?.output_dir || '/mnt/d/ObsidianVault/Douyin';
const CDP_URL = CONFIG.browser?.cdp_url || 'http://127.0.0.1:9222';
const GOTO_TIMEOUT_MS = CONFIG.browser?.goto_timeout_ms || 30000;
const WAIT_AFTER_NAV_MS = CONFIG.browser?.wait_after_navigate_ms || 3000;
const WAIT_AFTER_SCROLL_MS = CONFIG.browser?.wait_after_scroll_ms || 2000;
const FETCH_COMMENTS = CONFIG.scrape?.fetch_comments !== false;
const COMMENT_MAX_COUNT = CONFIG.scrape?.comment_max_count || 10;

// ============================================================
// 日志工具
// ============================================================
const LOG_PREFIX = {
  INFO: '[INFO]',
  WARN: '[WARN]',
  ERROR: '[ERROR]',
  DATA: '[DATA]',
  SUCCESS: '[SUCCESS]',
  FAIL: '[FAIL]',
};
const log = (level, msg) => console.log(`${LOG_PREFIX[level] || '[LOG]'} ${msg}`);

const FAILURE_LOG = [];
const fail = (reason, detail = '') => {
  FAILURE_LOG.push({ reason, detail, at: new Date().toISOString() });
  log('ERROR', `${reason}${detail ? ' | ' + detail : ''}`);
};

// ============================================================
// 工具函数
// ============================================================
function sanitizeFilename(str) {
  return String(str || '')
    // Windows 非法字符：\ / : * ? " < > |
    .replace(/[\\/:*?"<>|]/g, '-')
    // 控制字符
    .replace(/[\x00-\x1f\x7f]/g, '')
    // 连续空白/横线
    .replace(/[\s\u3000]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

function isValidDouyinUrl(url) {
  return /douyin\.com/i.test(url);
}

function buildFilename(data) {
  const today = new Date().toISOString().slice(0, 10);
  const author = sanitizeFilename(data.author);
  const title = sanitizeFilename(data.title);
  return `${today}-${author}-${title}.md`;
}

// ============================================================
// CDP 连接
// ============================================================
async function connectBrowser() {
  log('INFO', `尝试连接 CDP: ${CDP_URL}`);

  // 先确认端口能通
  try {
    const probe = await fetch(`${CDP_URL}/json/version`);
    if (!probe.ok) throw new Error(`/json/version 返回 ${probe.status}`);
    const info = await probe.json();
    log('INFO', `已连接到浏览器: ${info.Browser || 'unknown'}`);
  } catch (e) {
    fail('CDP 端口不可达', `请确认 Edge 已用 --remote-debugging-port=9222 启动: ${e.message}`);
    throw e;
  }

  // Playwright connectOverCDP
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    log('INFO', 'Playwright connectOverCDP 成功（复用本机 Edge 已登录态）');
  } catch (e) {
    fail('Playwright CDP 连接失败', e.message);
    throw e;
  }

  return browser;
}

// ============================================================
// 章节稳定等待
// ============================================================
async function waitForChapterStability(page) {
  const POLL_MS = 500;
  const MAX_WAIT_MS = 10000;
  const STABLE_ROUNDS = 2;  // 连续 N 次相同章节数才算稳定
  const start = Date.now();
  let lastCount = -1;
  let stableHits = 0;
  let lastItems = [];

  while (Date.now() - start < MAX_WAIT_MS) {
    const items = await page.evaluate(() => {
      const found = Array.from(document.querySelectorAll('li, div, span, p'))
        .map(e => (e.innerText || '').trim())
        .filter(t => /^\d{2}:\d{2}\s+\S/.test(t))
        .map(t => t.split('\n').slice(0, 2).join(' | '));
      // dedup
      return found.filter((v, i, a) => a.indexOf(v) === i).slice(0, 25);
    });

    if (items.length === lastCount && items.length > 0) {
      stableHits++;
      if (stableHits >= STABLE_ROUNDS) {
        return { items, elapsedMs: Date.now() - start };
      }
    } else {
      stableHits = 0;
      lastCount = items.length;
      lastItems = items;
    }

    await page.waitForTimeout(POLL_MS);
  }

  // 超时返回当前抓到的（可能不全，但比没有强）
  return { items: lastItems, elapsedMs: Date.now() - start };
}

// ============================================================
// 抓取核心（用实战验证的 DOM selector）
// ============================================================
async function scrapeDouyinPage(page, url) {
  log('INFO', `导航: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
  } catch (e) {
    // 网络/timeout 类错误 → 抛给上层 retry 包装
    fail('页面导航失败', e.message);
    throw e;
  }
  await page.waitForTimeout(WAIT_AFTER_NAV_MS);

  // --- 主视频元数据（data-e2e="detail-video-info" 是真视频容器）---
  const meta = await page.evaluate(() => {
    const out = { title: null, publishTime: null, stats: {}, author: null, videoId: null, url: location.href };
    out.videoId = location.pathname.match(/\/video\/(\d+)/)?.[1] || null;

    const info = document.querySelector('[data-e2e="detail-video-info"]');
    if (info) {
      out.title = (info.querySelector('h1, [class*="B7xjsf10"]') || {}).innerText?.trim()
        || info.innerText.split('\n')[0]?.trim()
        || null;
      const timeEl = info.querySelector('[data-e2e="detail-video-publish-time"]');
    if (timeEl) {
      out.publishTime = timeEl.innerText.replace(/^发布时间[：:]/, '').trim();
    } else {
      // /shipin/ 路径下可能没有 data-e2e，兜底用全文正则
      const m = info.innerText.match(/发布时间[：:]\s*(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/);
      if (m) out.publishTime = m[1];
    }
      // 数字（11.0万 / 8815 / 3.6万 / 3.1万）
      const nums = info.innerText.match(/\d+(?:\.\d+)?[万亿]?/g) || [];
      // 顺序：点赞 评论 收藏 分享（不一定都对，按位置猜）
      out.stats = { raw: nums.slice(0, 6) };
    }

    // 作者：抖音 PC 版作者卡片特征 = 包含 "粉丝" + 数字 + user 链接（不受 class 名/文字锚点变化影响）
    // 策略：在所有 a[href*="/user/"] 里，找其祖先节点文本含 "粉丝" 且 "已关注"/"关注" 的（这是作者卡片独占特征）
    const candidateAuthorLinks = Array.from(document.querySelectorAll('a[href*="/user/"]'))
      .filter(a => !a.getAttribute('href').includes('/user/self'));
    let authorLink = null;
    for (const a of candidateAuthorLinks) {
      // 爬 5 层祖先，找含 "粉丝" 字样的祖先
      let p = a;
      for (let i = 0; i < 5; i++) {
        p = p.parentElement;
        if (!p) break;
        const txt = p.innerText || '';
        if (txt.includes('粉丝') && /\d+\.?\d*\s*万?/.test(txt)) {
          authorLink = a;
          break;
        }
      }
      if (authorLink) break;
    }
    if (authorLink) {
      // 优先取链接的 innerText
      out.author = authorLink.innerText.trim() || null;
      // 文本为空就取 img alt（头像 alt 经常是作者名）
      if (!out.author) {
        const img = authorLink.querySelector('img[alt]');
        out.author = img?.getAttribute('alt') || null;
      }
      // 兜底：从祖先含"粉丝"的节点里抽第一行
      if (!out.author) {
        let p = authorLink;
        for (let i = 0; i < 5; i++) {
          p = p.parentElement;
          if (!p) break;
          const firstLine = (p.innerText || '').split('\n').map(s => s.trim()).find(s => s.length >= 2 && s.length <= 30);
          if (firstLine && !/^(粉丝|获赞|已关注|关注|私信)$/.test(firstLine)) {
            out.author = firstLine;
            break;
          }
        }
      }
    }

    return out;
  });

  if (!meta.title) fail('标题未抓到', 'detail-video-info 容器为空或无 h1');
  if (!meta.author) {
    fail('作者未抓到', '作者卡片 selector 失效或视频无作者信息');
    log('WARN', '作者未抓到（不影响继续）');
  }
  if (!meta.publishTime) {
    fail('发布时间未抓到', 'detail-video-publish-time 元素不存在');
    log('WARN', '发布时间未抓到');
  }

  // --- 章节列表（HH:MM 模式，自适应等待稳定）---
  // 抖音 PC 端章节是懒加载的，固定 wait_for_timeout 不够稳
  // 策略：每 500ms 探测一次章节数，连续 2 次相同则算稳定
  const chaptersResult = await waitForChapterStability(page);
  const chapters = chaptersResult.items;
  log('INFO', `章节: ${chapters.length} 条（稳定用时 ${chaptersResult.elapsedMs}ms）`);

  // --- 评论（需 scroll 触发懒加载）---
  let comments = [];
  if (FETCH_COMMENTS) {
    log('INFO', '滚动到底部触发评论加载...');
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(WAIT_AFTER_SCROLL_MS);
    } catch (e) {
      log('WARN', `滚动失败: ${e.message}`);
    }

    comments = await page.evaluate((max) => {
      // 评论条目指纹 = 含 "回复" + "分享" + 数字赞数 的最小重复 DOM 块
      // 抖音评论条目的稳定特征不是 class 名（class 经常变），而是 DOM 文本结构
      // 策略：先收集所有候选节点，再按结构过滤
      const allEls = Array.from(document.querySelectorAll('div, li, article, section'));

      // 候选：节点文本长度合理（>20 < 1500），且同时含 "回复" 和 "分享"
      const candidates = allEls.filter(el => {
        const txt = (el.innerText || '').trim();
        if (txt.length < 20 || txt.length > 1500) return false;
        if (!txt.includes('回复')) return false;
        if (!txt.includes('分享')) return false;
        // 必须含一个数字（赞数）— 但排除纯时间数字（"5天前"）
        if (!/\b\d{1,5}\b/.test(txt)) return false;
        return true;
      });

      // 取"最小"的那些（子节点最少的才是单条评论，大的可能是评论列表整体）
      // 按子元素数升序排，取前面若干
      candidates.sort((a, b) => a.children.length - b.children.length);

      // 再 dedup：如果 A 是 B 的祖先，跳 A
      const filtered = [];
      for (const c of candidates) {
        let isAncestor = false;
        for (const other of candidates) {
          if (other !== c && c.contains(other) && c !== other) {
            isAncestor = true;
            break;
          }
        }
        if (!isAncestor) filtered.push(c);
      }

      return filtered.slice(0, max).map(item => {
        const full = item.innerText.trim();
        // 提取用户名（首行）— 但首行可能是数字或时间，要排除
        const lines = full.split('\n').map(l => l.trim()).filter(Boolean);
        const user = lines[0] || '';
        // 提取时间
        const timeMatch = full.match(/(\d+天前|\d+小时前|\d+分钟前|刚刚|\d{4}-\d{2}-\d{2})/);
        const time = timeMatch ? timeMatch[0] : '';
        // 提取赞数：找 "分享" 前紧邻的纯数字
        const likesMatch = full.match(/(\d+)\s*\n?\s*分享/);
        const likes = likesMatch ? likesMatch[1] : '';
        // 提取正文：去除用户名、时间、赞数、按钮后的剩余
        const text = full
          .split('\n')
          .map(l => l.trim())
          .filter(l =>
            l.length > 0 &&
            l !== user &&
            !/^\d+(天|小时|分钟|秒)前/.test(l) &&
            !/^(刚刚|\d{4}-\d{2}-\d{2})/.test(l) &&
            !/^[\u4e00-\u9fa5]{2,3}$/.test(l) &&
            l !== '分享' && l !== '回复' &&
            !/^展开\d+条回复$/.test(l) &&
            !/^\d+$/.test(l) &&
            !/^·/.test(l)
          )
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        return { user, time, likes, text };
      }).filter(c => c.text && c.text.length > 3);
    }, COMMENT_MAX_COUNT);
    log('INFO', `评论: ${comments.length} 条`);
    if (comments.length === 0) {
      fail('评论未抓到', '未找到匹配"回复+分享+数字赞数"的评论条目 DOM（可能未登录或视频无评论）');
      log('WARN', '评论未抓到（可能未登录或视频无评论）');
    }
  } else {
    log('INFO', '配置 fetch_comments=false，跳过评论抓取');
  }

  // --- 字幕：本次未抓取（视频默认静音，字幕面板未自动展开）---
  // 文档明示 "字幕未获取" 时不报错中断
  const subtitle = null;
  log('INFO', '字幕：未获取（视频静音，字幕面板需手动展开）');

  return {
    title: meta.title,
    author: meta.author,
    publishTime: meta.publishTime,
    videoId: meta.videoId,
    inputUrl: url,         // 用户输入的 URL（短链）
    finalUrl: meta.url,    // 跳转后的 URL（带 video_id 的长链）
    stats: meta.stats,
    chapters,
    comments,
    subtitle,
  };
}

// ============================================================
// Markdown 渲染
// ============================================================
function buildMarkdown(data) {
  const now = new Date();
  const frontmatter = [
    '---',
    `title: "${(data.title || '未知标题').replace(/"/g, '\\"')}"`,
    `author: "${(data.author || '未知').replace(/"/g, '\\"')}"`,
    `original_url: "${data.inputUrl || data.finalUrl || ''}"`,
    `final_url: "${data.finalUrl || data.inputUrl || ''}"`,
    `publish_time: "${data.publishTime || '未知'}"`,
    `video_id: "${data.videoId || ''}"`,
    `scraped_at: "${now.toISOString()}"`,
    `tags: [抖音, douyin]`,
    '---',
    '',
  ].join('\n');

  const blocks = [];
  blocks.push(`# ${data.title || '未知标题'}`, '');

  // 元数据表
  blocks.push('## 元数据', '');
  blocks.push('| 字段 | 值 |', '|------|-----|');
  blocks.push(`| 作者 | ${data.author || '未知'} |`);
  blocks.push(`| 发布时间 | ${data.publishTime || '未知'} |`);
  blocks.push(`| 视频时长 | （未抓取） |`);
  if (data.stats?.raw?.length) {
    blocks.push(`| 互动数据（原始） | ${data.stats.raw.join(' / ')} |`);
  }
  if (data.inputUrl && data.finalUrl && data.inputUrl !== data.finalUrl) {
    blocks.push(`| 原始链接（用户输入） | ${data.inputUrl} |`);
    blocks.push(`| 跳转后链接 | ${data.finalUrl} |`);
  } else {
    blocks.push(`| 原始链接 | ${data.inputUrl || data.finalUrl || ''} |`);
  }
  blocks.push('');

  // 章节
  if (data.chapters.length) {
    blocks.push('## 章节', '');
    data.chapters.forEach(c => blocks.push(`- ${c}`));
    blocks.push('');
  }

  // 字幕
  blocks.push('## 字幕 / 可见文本', '');
  blocks.push('字幕未获取（视频默认静音，字幕面板未自动展开）', '');
  blocks.push('> 历史经验：可通过点击播放器右下角"字幕"按钮触发，但需要手动操作。', '');
  blocks.push('');

  // 评论
  blocks.push(`## 评论（共 ${data.comments.length} 条）`, '');
  if (data.comments.length === 0) {
    blocks.push('评论未获取', '');
  } else {
    blocks.push('| 用户 | 赞数 | 时间 | 评论 |', '|------|------|------|------|');
    data.comments.forEach(c => {
      const safeText = (c.text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      blocks.push(`| ${c.user} | ${c.likes} | ${c.time} | ${safeText} |`);
    });
    blocks.push('');
  }

  // 抓取日志（透明化失败点）
  blocks.push('## 抓取日志', '');
  blocks.push('```', `[INFO] 导航: ${data.finalUrl || data.inputUrl}`, `[INFO] 章节: ${data.chapters.length} 条`, `[INFO] 评论: ${data.comments.length} 条`, `[INFO] 字幕: 未获取`, `[INFO] 抓取完成: ${now.toISOString()}`, '```', '');

  return frontmatter + blocks.join('\n');
}

// ============================================================
// 股票词典（v0.3 轻量版，纯正则+静态词典，不用 LLM）
// ============================================================
const KNOWN_A_STOCKS = [
  // 评论区/章节里出现过的标的
  '长电科技', '深科技', '太极实业', '晶方科技', '利通电子', '盛合晶微',
  '彩虹股份', '京东方', '蓝思科技', '沃格光电', '立讯精密', '海康威视',
  '寒武纪', '海光信息', '中芯国际', '华大九天', '芯动科技', '浪潮信息',
  '华为', '意华股份', '瑞芯微', '超讯通信', '昇腾', '玄戒', '玻基',
  // A 股 6 位代码前缀是 60/30/00/68/20 等，识别不靠名字靠数字
];

function extractMentionedSymbols(data) {
  const symbols = [];
  const seen = new Set();

  // 把章节和评论拼成大文本
  const blob = [
    (data.title || ''),
    (data.author || ''),
    ...(data.chapters || []),
    ...(data.comments || []).map(c => c.text || ''),
  ].join('\n');

  // 1) 静态词典匹配（中文股票名）
  for (const name of KNOWN_A_STOCKS) {
    if (blob.includes(name) && !seen.has(`name:${name}`)) {
      symbols.push({ kind: 'a_stock_name', value: name });
      seen.add(`name:${name}`);
    }
  }

  // 2) A 股 6 位代码（必须以 0/3/6 开头避免误匹）
  const aCodes = blob.match(/\b[036]\d{5}\b/g) || [];
  for (const code of aCodes) {
    if (!seen.has(`code:${code}`)) {
      symbols.push({ kind: 'a_stock_code', value: code });
      seen.add(`code:${code}`);
    }
  }

  // 3) 港股代码：4-5 位数字 + .HK
  const hkCodes = blob.match(/\b\d{4,5}\.HK\b/gi) || [];
  for (const code of hkCodes) {
    if (!seen.has(`hk:${code}`)) {
      symbols.push({ kind: 'hk_stock_code', value: code.toUpperCase() });
      seen.add(`hk:${code}`);
    }
  }

  return symbols;
}

// ============================================================
// JSON 输出
// ============================================================
function buildJson(data) {
  // content_text：用 chapters + 关键评论拼一段纯文本描述（v0.3 没有正文文案）
  const contentParts = [];
  if (data.chapters.length) {
    contentParts.push('【章节】\n' + data.chapters.map((c, i) => `${i + 1}. ${c}`).join('\n'));
  }
  if (data.comments.length) {
    const topComments = data.comments.slice(0, 5)
      .map(c => `  - ${c.user} (${c.likes}赞): ${c.text}`)
      .join('\n');
    contentParts.push('【热门评论】\n' + topComments);
  }
  if (data.subtitle) {
    contentParts.push('【字幕】\n' + data.subtitle);
  }
  const contentText = contentParts.length ? contentParts.join('\n\n') : '';

  const mentionedSymbols = extractMentionedSymbols(data);

  const obj = {
    source_name: 'douyin',
    source_level: 'video',
    source_url: data.inputUrl || data.finalUrl || '',
    final_url: data.finalUrl || data.inputUrl || '',
    author: data.author || null,
    title: data.title || null,
    published_at: data.publishTime || null,
    content_text: contentText,
    chapters: data.chapters || [],
    comments: data.comments || [],
    mentioned_symbols: mentionedSymbols,
    scraped_at: new Date().toISOString(),
    raw_payload: {
      video_id: data.videoId || null,
      stats: data.stats || null,
      // raw_payload 不含 cookie（本来就没读）也不含 mp4 URL
    },
    failure_log: [...FAILURE_LOG],  // 拷贝一份，避免后续操作影响原数组
  };

  return JSON.stringify(obj, null, 2) + '\n';
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error('用法: node index.js "<douyin_url>"');
    console.error('示例: node index.js "https://v.douyin.com/2vX7spOC_sg/"');
    process.exit(1);
  }
  if (!isValidDouyinUrl(url)) {
    console.error('[ERROR] 不是有效的抖音链接（必须含 douyin.com）');
    process.exit(1);
  }

  console.log('========================================');
  log('INFO', 'douyin-link-to-obsidian');
  log('INFO', `配置: output=${OUTPUT_DIR}, cdp=${CDP_URL}, comments=${FETCH_COMMENTS ? `${COMMENT_MAX_COUNT}条` : 'off'}`);
  console.log('========================================');

  let browser;
  let page;
  let data = null;
  let filepath = null;

  try {
    browser = await connectBrowser();

    // 在共享 CDP 中建一个独立 context，避免污染你 Edge 已有 tab
    const context = await browser.newContext();
    page = await context.newPage();

    // 抓取（带重试：网络/CDP 错误重试 1 次）
    const RETRY_DELAY_MS = 1000;
    let attempts = 0;
    const maxAttempts = 2;
    let lastError = null;
    while (attempts < maxAttempts) {
      attempts++;
      try {
        data = await scrapeDouyinPage(page, url);
        if (attempts > 1) log('INFO', `第 ${attempts} 次重试成功`);
        break;
      } catch (e) {
        lastError = e;
        if (attempts < maxAttempts) {
          log('WARN', `第 ${attempts} 次抓取失败，${RETRY_DELAY_MS}ms 后重试: ${e.message}`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }
    if (!data) {
      throw lastError || new Error('抓取失败且无更多错误信息');
    }

    // 验收检查：标题/作者/文案 至少一项
    const hit = [data.title, data.author, data.publishTime].filter(Boolean).length;
    if (hit === 0) {
      fail('关键字段全空', '标题/作者/发布时间 都未抓到，可能被反爬或登录态失效');
      log('WARN', '继续生成文件（标注"未知"）以便人工补全');
    }

    // 写文件
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const filename = buildFilename(data);
    filepath = path.join(OUTPUT_DIR, filename);

    // 重名追加时间戳
    if (fs.existsSync(filepath)) {
      const ts = new Date().toISOString().slice(11, 19).replace(/:/g, '');
      filepath = path.join(OUTPUT_DIR, `${path.parse(filename).name}-${ts}${path.extname(filename)}`);
    }

    // v0.3: 同时写 .md 和 .json（同名不同后缀）
    fs.writeFileSync(filepath, buildMarkdown(data), 'utf8');
    log('SUCCESS', `已保存: ${filepath}`);

    const jsonFilepath = filepath.replace(/\.md$/, '.json');
    fs.writeFileSync(jsonFilepath, buildJson(data), 'utf8');
    log('SUCCESS', `已保存: ${jsonFilepath}`);

    // v0.3: 提及股票摘要
    const symbols = extractMentionedSymbols(data);
    if (symbols.length) {
      console.log(`提及股票: ${symbols.length} 个 → ${symbols.slice(0, 8).map(s => s.value).join(', ')}${symbols.length > 8 ? '...' : ''}`);
    }

    // 摘要输出
    console.log('\n----- 抓取摘要 -----');
    console.log(`标题: ${data.title || '(空)'}`);
    console.log(`作者: ${data.author || '(空)'}`);
    console.log(`发布时间: ${data.publishTime || '(空)'}`);
    console.log(`章节: ${data.chapters.length} 条`);
    console.log(`评论: ${data.comments.length} 条`);
    console.log(`字幕: 未获取`);
    console.log('--------------------\n');

  } catch (e) {
    fail('主流程异常', e.message);
    console.error(e.stack);
  } finally {
    // 关闭 context（不关闭 browser，因为是共用的）
    if (page) {
      try { await page.context().close(); } catch {}
    }

    // 失败时输出失败原因 + 抓取日志
    if (FAILURE_LOG.length > 0) {
      console.log('\n========== 失败原因汇总 ==========');
      FAILURE_LOG.forEach((f, i) => {
        console.log(`${i + 1}. [${f.at}] ${f.reason}`);
        if (f.detail) console.log(`   详情: ${f.detail}`);
      });
      console.log('====================================');
    }

    process.exit(FAILURE_LOG.length > 0 ? 1 : 0);
  }
}

main();
