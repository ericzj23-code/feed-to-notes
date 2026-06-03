#!/usr/bin/env node
/**
 * feed-to-notes (formerly douyin-link-to-obsidian)
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

// v0.6: AI 总结层（可选）
const SUMMARY_ENABLED = CONFIG.summary?.enabled === true;
const SUMMARY_PROVIDER = CONFIG.summary?.provider || 'minimax-cn';
const SUMMARY_MODEL = CONFIG.summary?.model || 'MiniMax-M2.7';
const SUMMARY_BASE_URL = CONFIG.summary?.base_url || 'https://api.minimaxi.com/anthropic';
const SUMMARY_MAX_TOKENS = CONFIG.summary?.max_tokens || 1024;
const SUMMARY_TIMEOUT_MS = CONFIG.summary?.timeout_ms || 30000;

// ============================================================
// v0.9 creator tracking 配置（缺省即用默认；不破坏 v0.7.1 兼容）
// ============================================================
const CT = CONFIG.creator_tracking || {};
const TRACKER_DIR = CT.tracker_dir || '/mnt/d/ObsidianVault/DouyinTracker';
const CT_STATE_DIR = path.join(TRACKER_DIR, 'state');
const CT_REPORT_DIR = path.join(TRACKER_DIR, 'reports');
const CT_QUEUE_DIR = path.join(TRACKER_DIR, 'queue');
const CT_LOG_DIR = path.join(TRACKER_DIR, 'logs');
const CT_MAX_VIDEOS = CT.max_videos_per_creator || 200;
const CT_SCROLL_STABLE_ROUNDS = CT.scroll_stable_rounds || 2;
const CT_SCROLL_MAX_NO_CHANGE = CT.scroll_max_no_change || 5;
const CT_SCROLL_PAUSE_MS = CT.scroll_pause_ms || 1500;

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
  // v0.10 改：优先用 publishedAt 真实发布日期，没有才 fallback 到抓取日
  const pub = data.publishTime && /^\d{4}-\d{2}-\d{2}/.test(data.publishTime)
    ? data.publishTime.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const author = sanitizeFilename(data.author);
  const title = sanitizeFilename(data.title);
  return `${pub}-${author}-${title}.md`;
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
      // v0.7.1 P2: 黑名单 — 过滤播放器控件文本
      // 注意：章节行通常是 "HH:MM | 章节标题"，但播放器控件会拼接成 "00:0X / 视频总时长 | 倍速/连播/..."
      // 所以用"包含"而不是"^...$"精确匹配
      const PLAYER_CONTROL_KEYWORDS = /因浏览器限制|当前为静音|倍速|连播|^播放$|^暂停$|清屏|智能(?!段)|画质|弹幕/;
      const found = Array.from(document.querySelectorAll('li, div, span, p'))
        .map(e => (e.innerText || '').trim())
        .filter(t => /^\d{2}:\d{2}\s+\S/.test(t))
        .filter(t => !PLAYER_CONTROL_KEYWORDS.test(t))
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
    out.videoId = location.pathname.match(/\/(?:video|shipin)\/(\d+)/)?.[1] || null;

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
    } else {
      // v0.7.1 P1: 降级 DOM 提取（detail-video-info 不存在时）
      // 长视频/特殊布局页可能没有这个容器，改用 <h1> + meta 标签
      const h1 = document.querySelector('h1');
      if (h1) out.title = h1.innerText.trim();
      // og:title 兜底
      if (!out.title) {
        const og = document.querySelector('meta[property="og:title"]');
        if (og) out.title = og.getAttribute('content')?.trim() || null;
      }
      // 发布时间：从 meta description / 全文正则
      const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      const m = metaDesc.match(/(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/)
        || document.body.innerText.match(/(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/);
      if (m) out.publishTime = m[1];
      // 互动数据：直接从 body 文本抽
      const nums = (document.body.innerText.match(/\d+(?:\.\d+)?[万亿]?/g) || []);
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

  // --- 字幕：尝试点开 .xgplayer-texttrack 按钮，选第一条 STT 轨道 ---
  // 抖音 PC 西瓜播放器（xgplayer）默认静音，字幕面板需手动展开
  // 路径：点击 .xgplayer-texttrack → 在弹出菜单中选 data-type ≠ "text-close" 的第一个 <li> → 等 2-3s 让 STT 加载 → 抓 .xg-text-track-content / 类似 DOM
  let subtitle = null;
  try {
    subtitle = await page.evaluate(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // 1) 找到字幕按钮
      const btn = document.querySelector('.xgplayer-texttrack');
      if (!btn) return { ok: false, reason: '字幕按钮未找到' };

      // 2) 点击展开菜单（用真实 mouse 事件序列触发 web component 内部 handler）
      const rect = btn.getBoundingClientRect();
      // xg-icon 自定义标签 getBoundingClientRect 可能 0，跳过坐标点击
      ['mousedown', 'mouseup', 'click'].forEach(t => {
        btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      });
      await sleep(500);

      // 3) 看菜单里有没有非"不开启"的轨道
      const items = Array.from(document.querySelectorAll('.xgplayer-texttrack .option-item'));
      if (items.length === 0) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); // 收起菜单
        return { ok: false, reason: '字幕菜单为空' };
      }
      const realItem = items.find(i => i.getAttribute('data-type') !== 'text-close');
      if (!realItem) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { ok: false, reason: '只有"不开启"项（视频无字幕轨道）' };
      }

      // 4) 点击选字幕轨道
      realItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await sleep(2500);  // 等 STT 字幕时间戳加载

      // 5) 抓字幕 DOM — xgplayer 字幕通常渲染在 .xgplayer-texttrack-content 或 video 容器下的 .text-block
      const textBlocks = Array.from(document.querySelectorAll(
        '.xgplayer-texttrack-content, .text-block, [class*="text-track"] [class*="content"], [class*="subtitle"] [class*="content"]'
      ));
      const lines = textBlocks
        .map(b => (b.innerText || '').trim())
        .filter(l => l.length > 0)
        // 去重保持顺序
        .filter((l, i, arr) => arr.indexOf(l) === i);

      if (lines.length === 0) {
        return { ok: false, reason: '点了字幕选项但未抓到字幕 DOM' };
      }

      return { ok: true, text: lines.join('\n'), count: lines.length };
    });
  } catch (e) {
    fail('字幕抓取异常', e.message);
    subtitle = { ok: false, reason: 'exception: ' + e.message };
  }

  if (subtitle && subtitle.ok) {
    log('INFO', `字幕: ${subtitle.count} 条（已展开）`);
  } else {
    const reason = (subtitle && subtitle.reason) || '未知失败';
    log('WARN', `字幕未获取（${reason}）`);
    subtitle = null;
  }

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
function yamlEscape(str) {
  // YAML 字符串安全化：含特殊字符（: # & * ? | > ! % @ ` [ ] { } , 等）时用双引号包裹
  // 内部双引号转义
  if (str === null || str === undefined) return '""';
  const s = String(str);
  // 纯安全（只含字母数字中文空白 - _）可不引号
  if (/^[\w\u4e00-\u9fa5\-_.\s]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 200)}"`;
}

function buildMarkdown(data) {
  const now = new Date();
  const symbols = extractMentionedSymbols(data);

  // tags 构造：基础 tag + 股票 tag（去重）
  const tags = new Set(['douyin', '抖音']);
  for (const s of symbols) {
    if (s.kind === 'a_stock_code') {
      tags.add(`stock/${s.value}`);  // 股票代码 tag，Dataview 友好
    } else if (s.kind === 'a_stock_name') {
      tags.add(`stock/${s.value}`);
    } else if (s.kind === 'hk_stock_code') {
      tags.add(`stock/${s.value}`);
    }
  }
  const tagsYaml = Array.from(tags).map(t => yamlEscape(t)).join(', ');

  // mentioned_symbols YAML 数组
  const symbolsYaml = symbols.length
    ? '\n' + symbols.map(s =>
        `  - kind: ${yamlEscape(s.kind)}\n    value: ${yamlEscape(s.value)}`
      ).join('\n')
    : ' []';

  const frontmatter = [
    '---',
    `title: ${yamlEscape(data.title || '未知标题')}`,
    `author: ${yamlEscape(data.author || '未知')}`,
    `source: ${yamlEscape('douyin')}`,
    `source_url: ${yamlEscape(data.inputUrl || data.finalUrl || '')}`,
    `final_url: ${yamlEscape(data.finalUrl || data.inputUrl || '')}`,
    `published_at: ${yamlEscape(data.publishTime || '')}`,
    `video_id: ${yamlEscape(data.videoId || '')}`,
    `scraped_at: ${yamlEscape(now.toISOString())}`,
    `mentioned_symbols:${symbolsYaml}`,
    `tags: [${tagsYaml}]`,
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
  if (data.subtitle) {
    blocks.push(data.subtitle, '');
  } else {
    blocks.push('字幕未获取（视频无 STT 字幕轨道，或 Edge 客户端未提供）', '');
    blocks.push('> 已尝试自动点开 .xgplayer-texttrack 按钮展开字幕面板。', '');
  }
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

  // v0.6: AI 总结（仅 enabled 且 data.summary 存在时）
  if (data.summary) {
    const s = data.summary;
    blocks.push('## AI 总结（v0.6，可选层）', '');
    if (s._meta) {
      blocks.push(`> 模型: ${s._meta.provider}/${s._meta.model}，生成时间: ${s._meta.generated_at}`);
      blocks.push('');
    }
    if (s.viewpoints?.length) {
      blocks.push('### 观点', '');
      s.viewpoints.forEach(v => blocks.push(`- ${v}`));
      blocks.push('');
    }
    if (s.risks?.length) {
      blocks.push('### 风险', '');
      s.risks.forEach(v => blocks.push(`- ${v}`));
      blocks.push('');
    }
    if (s.mentioned_symbols?.length) {
      blocks.push('### AI 提及的标的', '');
      s.mentioned_symbols.forEach(x => blocks.push(`- ${x.kind}: ${x.value}`));
      blocks.push('');
    }
    if (s.follow_ups?.length) {
      blocks.push('### 可跟踪问题', '');
      s.follow_ups.forEach(v => blocks.push(`- ${v}`));
      blocks.push('');
    }
    if (s.replicable_takeaways?.length) {
      blocks.push('### 可模仿点', '');
      s.replicable_takeaways.forEach(v => blocks.push(`- ${v}`));
      blocks.push('');
    }
  }

  // 抓取日志（透明化失败点）
  blocks.push('## 抓取日志', '');
  blocks.push('```', `[INFO] 导航: ${data.finalUrl || data.inputUrl}`, `[INFO] 章节: ${data.chapters.length} 条`, `[INFO] 评论: ${data.comments.length} 条`, `[INFO] 字幕: ${data.subtitle ? '已获取' : '未获取'}`, `[INFO] 抓取完成: ${now.toISOString()}`, '```', '');

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
    // v0.7.1 P3: summary 字段在 enabled=false 或 LLM 失败时为 null，整字段不写
    // （v0.6 行为：始终写 null；v0.7.1 行为：仅在有值时写）
  };
  if (data.summary) {
    obj.summary = data.summary;
  }

  return JSON.stringify(obj, null, 2) + '\n';
}

// ============================================================
// AI 总结层（v0.6，可选，不影响主流程）
// ============================================================
function buildSummaryPrompt(data) {
  // 拼一个简洁的"视频元数据卡"喂给 LLM
  const lines = [
    `标题: ${data.title || '(未知)'}`,
    `作者: ${data.author || '(未知)'}`,
    `发布时间: ${data.publishTime || '(未知)'}`,
    `原始链接: ${data.finalUrl || data.inputUrl || ''}`,
    '',
  ];
  if (data.chapters && data.chapters.length) {
    lines.push('章节:');
    data.chapters.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
    lines.push('');
  }
  if (data.comments && data.comments.length) {
    lines.push('热门评论（按赞数排序的前 5 条）:');
    data.comments
      .slice()
      .sort((a, b) => (parseInt(b.likes) || 0) - (parseInt(a.likes) || 0))
      .slice(0, 5)
      .forEach(c => lines.push(`  - ${c.user} (${c.likes}赞): ${c.text}`));
    lines.push('');
  }
  return lines.join('\n');
}

function parseSummaryJson(text) {
  // LLM 经常输出 markdown 包装或前后杂字，先 strip 再 parse
  // 策略：找第一个 { 和最后一个 } 之间的内容
  if (!text) return null;
  const trimmed = String(text).trim();
  // 去掉 ```json ... ``` 包装
  let s = trimmed;
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) s = fenceMatch[1].trim();
  // 找第一个 { 到最后一个 }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    s = s.slice(first, last + 1);
  }
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

async function callSummaryLLM(data) {
  if (!SUMMARY_ENABLED) return null;

  // API key 解析（按优先级）
  const apiKey = process.env.MINIMAX_CN_KEY
    || process.env.HERMES_MINIMAX_KEY
    || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log('WARN', 'summary.enabled=true 但未找到 API key (MINIMAX_CN_KEY / HERMES_MINIMAX_KEY / ANTHROPIC_API_KEY)，跳过');
    return null;
  }

  const systemPrompt = `你是内容分析专家。严格按 JSON 输出，不要 markdown 包装，不要解释。`;
  const userPrompt = `分析下面的抖音视频元数据，输出 JSON 5 字段（每个字段值是数组）：

- viewpoints: 创作者核心观点（1-3 条，每条 1 句话）
- risks: 投资/逻辑风险（0-3 条）
- mentioned_symbols: 提及的标的（数组，每项含 kind 字段: a_stock_name / a_stock_code / hk_stock_code，value 字段是名字或代码）
- follow_ups: 看完会想跟踪的问题（0-3 条）
- replicable_takeaways: 内容创作侧的可模仿点（0-3 条）

${buildSummaryPrompt(data)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

  try {
    const res = await fetch(`${SUMMARY_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        max_tokens: SUMMARY_MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      log('WARN', `LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }

    const respJson = await res.json();
    const text = respJson?.content?.[0]?.text || null;
    if (!text) {
      log('WARN', 'LLM 返回空 content');
      return null;
    }

    const parsed = parseSummaryJson(text);
    if (!parsed) {
      log('WARN', `LLM 返回无法解析为 JSON: ${text.slice(0, 200)}`);
      return null;
    }

    // 标准化字段（防止 LLM 返回奇怪的 key）
    return {
      viewpoints: Array.isArray(parsed.viewpoints) ? parsed.viewpoints : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks : [],
      mentioned_symbols: Array.isArray(parsed.mentioned_symbols) ? parsed.mentioned_symbols : [],
      follow_ups: Array.isArray(parsed.follow_ups) ? parsed.follow_ups : [],
      replicable_takeaways: Array.isArray(parsed.replicable_takeaways) ? parsed.replicable_takeaways : [],
      _meta: {
        provider: SUMMARY_PROVIDER,
        model: SUMMARY_MODEL,
        generated_at: new Date().toISOString(),
      },
    };
  } catch (e) {
    log('WARN', `LLM 调用失败: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function enrichWithSummary(data) {
  if (!SUMMARY_ENABLED) return data;
  log('INFO', 'AI 总结层启用，调用 LLM...');
  const summary = await callSummaryLLM(data);
  if (summary) {
    data.summary = summary;
    const n = (summary.viewpoints?.length || 0) + (summary.risks?.length || 0) +
              (summary.mentioned_symbols?.length || 0) + (summary.follow_ups?.length || 0) +
              (summary.replicable_takeaways?.length || 0);
    log('INFO', `AI 总结完成: 共 ${n} 条`);
  } else {
    log('WARN', 'AI 总结失败，继续（不影响主流程）');
  }
  return data;
}

// ============================================================
// urls.txt 解析
// ============================================================
function parseUrlsFile(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`urls 文件不存在: ${filepath}`);
  }
  const text = fs.readFileSync(filepath, 'utf8');
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
  return lines;
}

// ============================================================
// 已抓过链接扫描（看 OUTPUT_DIR 下所有子目录里的 .json 的 source_url/final_url/video_id）
// v0.10 改：递归扫子目录（之前只看顶层，新版按作者分目录后必须递归）
// v0.11 改：返回 { urls, videoIds } 双索引
//   - urls：source_url + final_url → filepath（快路径,挡完全相同输入）
//   - videoIds：raw_payload.video_id → filepath（兜底,挡"换链接形式的同一视频"）
function scanAlreadyScraped() {
  const urls = new Map();      // url -> filepath
  const videoIds = new Map();  // video_id -> filepath
  if (!fs.existsSync(OUTPUT_DIR)) return { urls, videoIds };

  // 递归收集所有 .json：OUTPUT_DIR 下所有 .json + 直属子目录下的 .json
  const files = [];
  for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(path.join(OUTPUT_DIR, entry.name));
    } else if (entry.isDirectory()) {
      const sub = path.join(OUTPUT_DIR, entry.name);
      try {
        for (const sf of fs.readdirSync(sub)) {
          if (sf.endsWith('.json')) files.push(path.join(sub, sf));
        }
      } catch (e) { /* 跳过不可读目录 */ }
    }
  }

  for (const full of files) {
    try {
      const obj = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (obj.source_url) urls.set(obj.source_url, full);
      if (obj.final_url && obj.final_url !== obj.source_url) urls.set(obj.final_url, full);
      const vid = obj.raw_payload && obj.raw_payload.video_id;
      if (vid) videoIds.set(String(vid), full);
    } catch (e) {
      // JSON 损坏不影响扫描
    }
  }
  return { urls, videoIds };
}

// 把刚抓完的一条结果合并进 dedup 索引（防止同一 urls.txt 内部重复）
// 增量更新：source_url / final_url / video_id 都补进去,后续 URL 命中走快路径
function indexScrapedResult(index, data, filepath) {
  if (data.inputUrl) index.urls.set(data.inputUrl, filepath);
  if (data.finalUrl && data.finalUrl !== data.inputUrl) index.urls.set(data.finalUrl, filepath);
  if (data.videoId) index.videoIds.set(String(data.videoId), filepath);
}

// ============================================================
// 单条 URL 处理（被 main / batch 复用）
// v0.11 改：dedupIndex 由外层（runBatch / runSingle）扫一次传入,本函数不再自扫
//   - dedupIndex.urls 命中 → A 路径 skip（快路径,0 网络）
//   - scrape 拿到 videoId 后查 dedupIndex.videoIds 命中 → B 路径 skip（白跑一次 scrape）
// ============================================================
async function processOneUrl(url, browser, sharedContext, dedupIndex, options = {}) {
  const { isBatch = false } = options;
  const startedAt = Date.now();
  const result = {
    url,
    status: 'failed',  // success / skipped / failed
    file: null,
    reason: null,
    failure_log: [],
    elapsed_ms: 0,
  };

  // 已抓过检查（A 路径：URL 字符串命中,快路径）
  if (dedupIndex.urls.has(url)) {
    result.status = 'skipped';
    result.reason = `已抓过 (URL 命中: ${path.basename(dedupIndex.urls.get(url))})`;
    result.elapsed_ms = Date.now() - startedAt;
    log('INFO', `跳过（已抓过）: ${url}`);
    return result;
  }

  // 清空 FAILURE_LOG（避免跨 URL 串）
  FAILURE_LOG.length = 0;

  let page;
  try {
    // 每条 URL 用独立 page（共享 context 减少资源）
    page = await sharedContext.newPage();
    const context = page;  // 兼容旧代码

    // 抓取（带重试）
    const RETRY_DELAY_MS = 1000;
    let attempts = 0;
    const maxAttempts = 2;
    let lastError = null;
    let data = null;
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

    // 验收检查
    const hit = [data.title, data.author, data.publishTime].filter(Boolean).length;
    if (hit === 0) {
      fail('关键字段全空', '标题/作者/发布时间 都未抓到，可能被反爬或登录态失效');
      log('WARN', '继续生成文件（标注"未知"）以便人工补全');
    }

    // B 路径：scrape 拿到 videoId 后再查 video_ids 索引,挡"换链接形式的同一视频"
    // 代价:这条 URL 白跑了一次 scrape,但 B 不是主路径,可接受
    // elapsed_ms 照实记录（不归零）,承认"白跑了 X 秒"才是诚实数据
    if (data.videoId && dedupIndex.videoIds.has(String(data.videoId))) {
      result.status = 'skipped';
      result.reason = `已抓过 (video_id 命中: ${path.basename(dedupIndex.videoIds.get(String(data.videoId)))})`;
      result.elapsed_ms = Date.now() - startedAt;
      log('INFO', `跳过（video_id 已存在）: ${url} (video_id=${data.videoId})`);
      return result;
    }

    // 写文件 — 按作者分子目录（v0.10 新增）
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const authorSubdir = sanitizeFilename(data.author) || '_untitled';
    const authorDir = path.join(OUTPUT_DIR, authorSubdir);
    if (!fs.existsSync(authorDir)) fs.mkdirSync(authorDir, { recursive: true });
    const filename = buildFilename(data);
    let filepath = path.join(authorDir, filename);

    if (fs.existsSync(filepath)) {
      const ts = new Date().toISOString().slice(11, 19).replace(/:/g, '');
      filepath = path.join(authorDir, `${path.parse(filename).name}-${ts}${path.extname(filename)}`);
    }

    fs.writeFileSync(filepath, buildMarkdown(data), 'utf8');
    log('SUCCESS', `已保存: ${filepath}`);

    const jsonFilepath = filepath.replace(/\.md$/, '.json');
    fs.writeFileSync(jsonFilepath, buildJson(data), 'utf8');
    log('SUCCESS', `已保存: ${jsonFilepath}`);

    // 增量更新 dedup 索引（防止同一 urls.txt 内后续行重复 scrape）
    indexScrapedResult(dedupIndex, data, jsonFilepath);

    // v0.6: AI 总结层（在原始内容已写盘后追加，不影响主流程）
    // 失败时不重写文件，原始内容保留；成功时把 summary 注入 data 并重写文件
    try {
      await enrichWithSummary(data);
      if (data.summary) {
        fs.writeFileSync(filepath, buildMarkdown(data), 'utf8');
        fs.writeFileSync(jsonFilepath, buildJson(data), 'utf8');
        log('SUCCESS', `已附加 AI 总结到: ${filepath}`);
      }
    } catch (e) {
      log('WARN', `AI 总结层异常（已忽略）: ${e.message}`);
    }

    result.status = 'success';
    result.file = filepath;
    result.json_file = jsonFilepath;
    result.failure_log = [...FAILURE_LOG];

    // 摘要（单条模式才打印，批量模式每条都打太长）
    if (!isBatch) {
      const symbols = extractMentionedSymbols(data);
      if (symbols.length) {
        console.log(`提及股票: ${symbols.length} 个 → ${symbols.slice(0, 8).map(s => s.value).join(', ')}${symbols.length > 8 ? '...' : ''}`);
      }
      console.log('\n----- 抓取摘要 -----');
      console.log(`标题: ${data.title || '(空)'}`);
      console.log(`作者: ${data.author || '(空)'}`);
      console.log(`发布时间: ${data.publishTime || '(空)'}`);
      console.log(`章节: ${data.chapters.length} 条`);
      console.log(`评论: ${data.comments.length} 条`);
      console.log(`字幕: 未获取`);
      console.log('--------------------\n');
    }
  } catch (e) {
    result.status = 'failed';
    result.reason = e.message;
    result.failure_log = [...FAILURE_LOG];
    fail('抓取异常', e.message);
    if (!isBatch) console.error(e.stack);
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
    result.elapsed_ms = Date.now() - startedAt;
  }

  return result;
}

// ============================================================
// 主流程
// ============================================================
async function runSingle(url) {
  console.log('========================================');
  log('INFO', 'feed-to-notes (单条模式)');
  log('INFO', `配置: output=${OUTPUT_DIR}, cdp=${CDP_URL}, comments=${FETCH_COMMENTS ? `${COMMENT_MAX_COUNT}条` : 'off'}`);
  console.log('========================================');

  let browser;
  try {
    browser = await connectBrowser();
    const context = await browser.newContext();
    // v0.11 改：单条也走 dedup 索引（保持签名一致;空库起步,本条命中就 skip）
    const dedupIndex = scanAlreadyScraped();
    const result = await processOneUrl(url, browser, context, dedupIndex, { isBatch: false });
    return result;
  } catch (e) {
    log('ERROR', `主流程异常: ${e.message}`);
    return { url, status: 'failed', reason: e.message, failure_log: [...FAILURE_LOG] };
  }
}

async function runBatch(urlsFile) {
  console.log('========================================');
  log('INFO', 'feed-to-notes (批量模式)');
  log('INFO', `urls 文件: ${urlsFile}`);
  log('INFO', `配置: output=${OUTPUT_DIR}, cdp=${CDP_URL}, comments=${FETCH_COMMENTS ? `${COMMENT_MAX_COUNT}条` : 'off'}`);
  console.log('========================================');

  let urls;
  try {
    urls = parseUrlsFile(urlsFile);
  } catch (e) {
    log('ERROR', e.message);
    return null;
  }

  if (urls.length === 0) {
    log('ERROR', `urls 文件为空或全部是注释: ${urlsFile}`);
    return null;
  }
  log('INFO', `共 ${urls.length} 条 URL`);

  // 校验所有 URL
  const invalid = urls.filter(u => !isValidDouyinUrl(u));
  if (invalid.length) {
    log('WARN', `${invalid.length} 条 URL 不是 douyin.com，已跳过: ${invalid.slice(0, 3).join(', ')}...`);
    urls = urls.filter(u => isValidDouyinUrl(u));
  }

  const batchStartedAt = new Date().toISOString();
  const items = [];
  let browser, context;

  // v0.11 改：dedup 索引外提（一次扫盘 + 一次 parse,O(M) 摊到整个 batch）
  // 原 O(N×M) 重扫是批量性能咬人的根因（每条 URL 都重扫所有 .json）
  const dedupIndex = scanAlreadyScraped();
  log('INFO', `dedup 索引: ${dedupIndex.urls.size} 个 URL / ${dedupIndex.videoIds.size} 个 video_id`);

  try {
    browser = await connectBrowser();
    context = await browser.newContext();

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`\n[${i + 1}/${urls.length}] ${url}`);
      const result = await processOneUrl(url, browser, context, dedupIndex, { isBatch: true });
      items.push(result);
      // 条目之间间隔 1s（防止抖音反爬）
      if (i < urls.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } catch (e) {
    log('ERROR', `批量主流程异常: ${e.message}`);
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
  }

  const batchFinishedAt = new Date().toISOString();
  const summary = {
    batch_started_at: batchStartedAt,
    batch_finished_at: batchFinishedAt,
    total: items.length,
    success: items.filter(i => i.status === 'success').length,
    skipped: items.filter(i => i.status === 'skipped').length,
    failed: items.filter(i => i.status === 'failed').length,
    items,
  };

  // 写 batch-log.json
  const logPath = path.join(OUTPUT_DIR, 'batch-log.json');
  // 如果已有就追加（保留历史）
  let existingLog = [];
  if (fs.existsSync(logPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      existingLog = Array.isArray(prev) ? prev : (prev.batches || []);
    } catch (e) {}
  }
  existingLog.push(summary);
  fs.writeFileSync(logPath, JSON.stringify({ batches: existingLog }, null, 2) + '\n', 'utf8');
  log('SUCCESS', `已保存: ${logPath}`);

  // 打印汇总
  console.log('\n========== 批量抓取汇总 ==========');
  console.log(`总数: ${summary.total}`);
  console.log(`成功: ${summary.success}`);
  console.log(`跳过（已抓过）: ${summary.skipped}`);
  console.log(`失败: ${summary.failed}`);
  console.log(`总耗时: ${((new Date(batchFinishedAt) - new Date(batchStartedAt)) / 1000).toFixed(1)}s`);
  console.log('====================================');

  return summary;
}

// ============================================================
// v0.9 creator tracking（博主主页追踪）
// 范围：抓作品 tab 的视频列表 + 维护 state + 生成报告
// 不抓 mp4 / 不调 LLM / 不抓单视频
// ============================================================

// 从博主 URL 提取 sec_uid（user/<sec_uid> 形式）
function extractSecUid(url) {
  // 处理跳转后 URL / 短链跳转后 / 显式 sec_uid
  // 形态：https://www.douyin.com/user/MS4wLjABAAAA... 或带 ?tab=post 等 query
  const m = String(url || '').match(/\/user\/([A-Za-z0-9_\-]+)/);
  return m ? m[1] : null;
}

// 校验博主 URL 形态：必须是 douyin.com/user/<sec_uid>
function isValidCreatorUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.includes('douyin.com')) return false;
  return extractSecUid(url) !== null;
}

// 抓博主主页"作品"tab：返回 {sec_uid, nickname, follower, follow, liked, signature, videos:[{aweme_id, title, href}]}
async function scrapeCreatorPage(page, secUid) {
  const targetUrl = `https://www.douyin.com/user/${secUid}?tab=post`;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
  await page.waitForTimeout(WAIT_AFTER_NAV_MS);

  // 滚动抓作品列表
  const seen = new Map(); // aweme_id -> {aweme_id, title, href}
  let stableRounds = 0;
  let noChangeRounds = 0;
  let lastTotal = 0;

  for (let i = 0; i < 200; i++) { // 200 次滚动是硬上限（即便配置再大也兜底）
    const round = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      const cards = [];
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/video\/(\d+)/);
        if (!m) continue;
        const id = m[1];
        // 标题：往上找祖先拿全文，截 [a 之后的 p]
        let title = null;
        let node = a;
        for (let k = 0; k < 6; k++) {
          if (!node.parentElement) break;
          node = node.parentElement;
        }
        // 在卡片容器里找一个最像标题的 p
        const ps = node.querySelectorAll('p');
        for (const p of ps) {
          const t = (p.innerText || '').trim();
          if (t && t.length >= 2 && t.length < 200) {
            title = t;
            break;
          }
        }
        cards.push({ id, href: href.startsWith('http') ? href : `https://www.douyin.com${href.startsWith('/') ? '' : '/'}${href}`, title });
      }
      return cards;
    });

    for (const c of round) {
      if (!seen.has(c.id)) {
        seen.set(c.id, { aweme_id: c.id, title: c.title, href: c.href });
      }
    }

    const curTotal = seen.size;
    if (curTotal >= CT_MAX_VIDEOS) {
      log('INFO', `达到 max_videos_per_creator=${CT_MAX_VIDEOS}，停止滚动`);
      break;
    }
    if (curTotal === lastTotal) {
      noChangeRounds++;
      stableRounds++;
      if (stableRounds >= CT_SCROLL_STABLE_ROUNDS || noChangeRounds >= CT_SCROLL_MAX_NO_CHANGE) {
        log('INFO', `连续无新视频（stable=${stableRounds}, noChange=${noChangeRounds}），停止滚动`);
        break;
      }
    } else {
      stableRounds = 0;
      noChangeRounds = 0;
    }
    lastTotal = curTotal;

    // 触发懒加载
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.2));
    await page.waitForTimeout(CT_SCROLL_PAUSE_MS);
  }

  // 抓博主元信息
  const meta = await page.evaluate(() => {
    const body = document.body.innerText || '';
    const follower = (body.match(/粉丝\s*([\d.]+\s*[万亿]?)/) || [])[1] || null;
    const follow   = (body.match(/关注\s*(\d+(?:\.\d+)?\s*[万亿]?)/) || [])[1] || null;
    const liked    = (body.match(/获赞\s*([\d.]+\s*[万亿]?)/) || [])[1] || null;
    // 昵称：拿 user-title 块的首行（去掉"关注/粉丝/获赞"等元数据行）
    const titleEl = document.querySelector('[class*="user-title"]');
    let nickname = null;
    if (titleEl) {
      const t = (titleEl.innerText || '').trim();
      // 首行通常是昵称
      nickname = t.split('\n')[0].trim() || null;
    }
    if (!nickname) {
      // 兜底：找 h1 / og:title
      const h1 = document.querySelector('h1');
      if (h1) nickname = (h1.innerText || '').trim().split('\n')[0].trim() || null;
    }
    if (!nickname) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og) nickname = (og.getAttribute('content') || '').trim() || null;
    }
    // 签名：找"个人简介"附近的 p
    let signature = null;
    const allP = Array.from(document.querySelectorAll('p'));
    for (const p of allP) {
      const t = (p.innerText || '').trim();
      if (t && t.length > 5 && t.length < 200 && !/^\d+/.test(t) && !/[☐☜]/.test(t)) {
        // 排除明显元数据
        if (!/粉丝|关注|获赞|抖音号|IP属地|岁$/.test(t)) {
          signature = t;
          break;
        }
      }
    }
    return { nickname, follower, follow, liked, signature };
  });

  return {
    sec_uid: secUid,
    nickname: meta.nickname,
    follower: meta.follower,
    follow: meta.follow,
    liked: meta.liked,
    signature: meta.signature,
    videos: Array.from(seen.values()),
  };
}

// 加载 state；不存在返回 null
function loadCreatorState(secUid) {
  const fp = path.join(CT_STATE_DIR, `${secUid}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    log('WARN', `state 解析失败（${fp}）: ${e.message}，视为无 state`);
    return null;
  }
}

// 写 state
function saveCreatorState(secUid, data) {
  if (!fs.existsSync(CT_STATE_DIR)) fs.mkdirSync(CT_STATE_DIR, { recursive: true });
  const fp = path.join(CT_STATE_DIR, `${secUid}.json`);
  const now = new Date().toISOString();
  const prev = loadCreatorState(secUid);
  const knownSet = new Set(prev?.known_aweme_ids || []);
  for (const v of data.videos) knownSet.add(v.aweme_id);
  const state = {
    sec_uid: secUid,
    nickname: data.nickname,
    first_seen: prev?.first_seen || now,
    last_checked: now,
    known_aweme_ids: Array.from(knownSet),
    last_run_summary: {
      total_found: data.videos.length,
      new_count: data.newCount,
      new_aweme_ids: data.newAwemeIds,
    },
  };
  fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf8');
  return { fp, state };
}

// 生成 report md
function buildCreatorReport(secUid, data, statePath) {
  const now = new Date().toISOString();
  const isBaseline = data.isBaseline;
  // 数据清洗：去掉换行/多余空白（防止 markdown 表格断裂）
  const clean = (v) => v == null ? '(未获取)' : String(v).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || '(未获取)';
  const head = [
    isBaseline ? '# [BASELINE] 博主主页首次建档报告' : '# 博主主页追踪报告',
    '',
    '| 字段 | 值 |',
    '|------|-----|',
    `| sec_uid | \`${secUid}\` |`,
    `| 昵称 | ${clean(data.nickname)} |`,
    `| 粉丝 | ${clean(data.follower)} |`,
    `| 关注 | ${clean(data.follow)} |`,
    `| 获赞 | ${clean(data.liked)} |`,
    `| 签名 | ${clean(data.signature)} |`,
    `| 本次抓到 | ${data.videos.length} 个视频 |`,
    `| 新增 | ${data.newCount} 个 |`,
    `| 运行时间 | ${now} |`,
    `| 模式 | ${isBaseline ? 'BASELINE（建档）' : 'DELTA（追踪）'} |`,
    `| state 文件 | \`${statePath}\` |`,
    '',
  ];

  let body = '';
  if (isBaseline) {
    body = '## 全部视频（首次建档，请人工核对）\n\n';
    body += '| # | aweme_id | 标题 | 链接 |\n';
    body += '|---|----------|------|------|\n';
    data.videos.forEach((v, i) => {
      const t = (v.title || '(无标题)').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      body += `| ${i + 1} | \`${v.aweme_id}\` | ${t} | [打开](${v.href}) |\n`;
    });
  } else {
    body = '## 新增视频\n\n';
    if (data.newCount === 0) {
      body += '本次没有新增视频。\n';
    } else {
      body += '| # | aweme_id | 标题 | 链接 |\n';
      body += '|---|----------|------|------|\n';
      const newSet = new Set(data.newAwemeIds);
      data.videos.filter(v => newSet.has(v.aweme_id)).forEach((v, i) => {
        const t = (v.title || '(无标题)').replace(/\|/g, '\\|').replace(/\n/g, ' ');
        body += `| ${i + 1} | \`${v.aweme_id}\` | ${t} | [打开](${v.href}) |\n`;
      });
    }
    body += '\n## 本次抓到全部（仅作参考）\n\n';
    body += `本次共抓 ${data.videos.length} 个视频，其中 ${data.newCount} 个为新增（其余已在 state 中）。\n`;
  }

  return head.join('\n') + '\n' + body;
}

// 跑单博主：抓 + diff + 写 state + 写 report
async function runCreator(url, options = {}) {
  const { isBatch = false } = options;
  const startedAt = Date.now();
  const secUid = extractSecUid(url);
  if (!secUid) {
    return { url, status: 'failed', reason: '无法提取 sec_uid（URL 必须含 /user/<sec_uid>）', file: null, elapsed_ms: 0 };
  }

  const result = { url, sec_uid: secUid, status: 'failed', file: null, reason: null, elapsed_ms: 0 };

  log('INFO', `开始追踪博主: sec_uid=${secUid}`);
  let browser;
  let sharedContext;
  try {
    browser = await connectBrowser();
    sharedContext = browser.contexts()[0] || await browser.newContext();
  } catch (e) {
    result.reason = `CDP 连接失败: ${e.message}`;
    result.elapsed_ms = Date.now() - startedAt;
    return result;
  }

  let page;
  try {
    page = await sharedContext.newPage();
    const data = await scrapeCreatorPage(page, secUid);
    await page.close();

    // diff
    const prev = loadCreatorState(secUid);
    const isBaseline = !prev;
    const knownSet = new Set(prev?.known_aweme_ids || []);
    const newIds = data.videos.filter(v => !knownSet.has(v.aweme_id)).map(v => v.aweme_id);

    const enriched = { ...data, isBaseline, newCount: isBaseline ? data.videos.length : newIds.length, newAwemeIds: newIds };

    // 写 state
    const { fp: stateFp } = saveCreatorState(secUid, enriched);

    // 写 report
    if (!fs.existsSync(CT_REPORT_DIR)) fs.mkdirSync(CT_REPORT_DIR, { recursive: true });
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10);
    const timePart = now.toISOString().slice(11, 19).replace(/:/g, '');
    const reportName = `${secUid}-${datePart}-${timePart}${isBaseline ? '-BASELINE' : ''}.md`;
    const reportFp = path.join(CT_REPORT_DIR, reportName);
    const reportContent = buildCreatorReport(secUid, enriched, stateFp);
    fs.writeFileSync(reportFp, reportContent, 'utf8');

    log('SUCCESS', `[${isBaseline ? 'BASELINE' : 'DELTA'}] sec_uid=${secUid} 抓 ${data.videos.length} 条, 新增 ${enriched.newCount} 条`);
    log('SUCCESS', `state: ${stateFp}`);
    log('SUCCESS', `report: ${reportFp}`);

    if (!isBatch) {
      console.log('\n----- 博主追踪摘要 -----');
      console.log(`昵称: ${data.nickname || '(未获取)'}`);
      console.log(`粉丝: ${data.follower || '(未获取)'} | 关注: ${data.follow || '(未获取)'} | 获赞: ${data.liked || '(未获取)'}`);
      console.log(`本次抓到: ${data.videos.length} 个视频`);
      console.log(`新增: ${enriched.newCount} 个`);
      console.log(`模式: ${isBaseline ? 'BASELINE' : 'DELTA'}`);
      console.log('------------------------\n');
    }

    result.status = 'success';
    result.file = reportFp;
    result.state_file = stateFp;
    result.new_count = enriched.newCount;
    result.total_found = data.videos.length;
  } catch (e) {
    result.reason = e.message;
    if (page) try { await page.close(); } catch {}
    fail('博主追踪异常', e.message);
  }
  result.elapsed_ms = Date.now() - startedAt;
  return result;
}

// 批量博主：复用 runCreator
async function runCreatorsBatch(filepath) {
  if (!fs.existsSync(filepath)) {
    console.error(`[ERROR] 博主文件不存在: ${filepath}`);
    return null;
  }
  const text = fs.readFileSync(filepath, 'utf8');
  const urls = text.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
  if (urls.length === 0) {
    console.error('[ERROR] 博主文件为空');
    return null;
  }
  log('INFO', `批量博主模式: ${urls.length} 个博主`);
  const items = [];
  for (const url of urls) {
    if (!isValidCreatorUrl(url)) {
      log('WARN', `跳过无效博主 URL: ${url}`);
      items.push({ url, status: 'failed', reason: '不是有效博主 URL（必须含 douyin.com/user/<sec_uid>）' });
      continue;
    }
    const r = await runCreator(url, { isBatch: true });
    items.push(r);
    log('INFO', `--- ${r.status} | ${r.url} ---`);
  }
  const summary = {
    total: urls.length,
    success: items.filter(i => i.status === 'success').length,
    failed: items.filter(i => i.status === 'failed').length,
  };
  log('INFO', `批量博主汇总: total=${summary.total} success=${summary.success} failed=${summary.failed}`);
  return { ...summary, items };
}

async function main() {
  const args = process.argv.slice(2);

  // 互斥检查：--file 和 --creators-file 不能同时给
  const hasFile = args.includes('--file') || args.includes('-f');
  const hasCreatorsFile = args.includes('--creators-file');
  if (hasFile && hasCreatorsFile) {
    console.error('[ERROR] --file 和 --creators-file 不能同时使用');
    process.exit(1);
  }

  // 单博主模式：node index.js --creator "<url>"
  if (args[0] === '--creator') {
    const url = args[1];
    if (!url) {
      console.error('用法: node index.js --creator "<creator_url>"');
      console.error('示例: node index.js --creator "https://www.douyin.com/user/MS4wLjABAAAA..."');
      process.exit(1);
    }
    if (!isValidCreatorUrl(url)) {
      console.error('[ERROR] 不是有效的博主 URL（必须含 douyin.com/user/<sec_uid>）');
      process.exit(1);
    }
    const result = await runCreator(url, { isBatch: false });
    if (result.status === 'failed') {
      console.error(`[ERROR] 博主追踪失败: ${result.reason}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // 批量博主模式：node index.js --creators-file file.txt
  if (hasCreatorsFile) {
    const filepath = args[1];
    if (!filepath) {
      console.error('用法: node index.js --creators-file <creators.txt>');
      process.exit(1);
    }
    const summary = await runCreatorsBatch(filepath);
    if (!summary) process.exit(1);
    process.exit(summary.failed > 0 ? 1 : 0);
  }

  // 批量视频模式：node index.js --file urls.txt
  if (hasFile) {
    const urlsFile = args[1];
    if (!urlsFile) {
      console.error('用法: node index.js --file <urls.txt>');
      process.exit(1);
    }
    const summary = await runBatch(urlsFile);
    if (!summary) process.exit(1);
    // 批量模式：只要有 failed 就 exit 1
    process.exit(summary.failed > 0 ? 1 : 0);
  }

  // 单条模式：node index.js "<url>"
  const url = args[0];
  if (!url) {
    console.error('用法:');
    console.error('  单视频:     node index.js "<douyin_url>"');
    console.error('  批量视频:   node index.js --file <urls.txt>');
    console.error('  单博主:     node index.js --creator "<creator_url>"');
    console.error('  批量博主:   node index.js --creators-file <creators.txt>');
    console.error('示例: node index.js "https://v.douyin.com/2vX7spOC_sg/"');
    process.exit(1);
  }
  if (!isValidDouyinUrl(url)) {
    console.error('[ERROR] 不是有效的抖音链接（必须含 douyin.com）');
    process.exit(1);
  }

  const result = await runSingle(url);

  if (result.status === 'failed') {
    if (result.failure_log && result.failure_log.length > 0) {
      console.log('\n========== 失败原因汇总 ==========');
      result.failure_log.forEach((f, i) => {
        console.log(`${i + 1}. [${f.at}] ${f.reason}`);
        if (f.detail) console.log(`   详情: ${f.detail}`);
      });
      console.log('====================================');
    }
    process.exit(1);
  }
  process.exit(0);
}

main();
