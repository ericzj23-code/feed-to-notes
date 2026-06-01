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
// 抓取核心（用实战验证的 DOM selector）
// ============================================================
async function scrapeDouyinPage(page, url) {
  log('INFO', `导航: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
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
      if (timeEl) out.publishTime = timeEl.innerText.replace(/^发布时间：/, '').trim();
      // 数字（11.0万 / 8815 / 3.6万 / 3.1万）
      const nums = info.innerText.match(/\d+(?:\.\d+)?[万亿]?/g) || [];
      // 顺序：点赞 评论 收藏 分享（不一定都对，按位置猜）
      out.stats = { raw: nums.slice(0, 6) };
    }

    // 作者：抖音 PC 版把作者信息塞在 related-video 节点里，但作者 user_id 唯一
    // 策略：找"作者"二字附近的 a[href*="/user/"]
    const authorLink = Array.from(document.querySelectorAll('a[href*="/user/"]'))
      .find(a => {
        // 取带 "作者" 后缀的、或其父节点文本含 "作者" 的
        const parent = a.parentElement?.parentElement;
        return (parent?.innerText || '').includes('作者');
      });
    if (authorLink) {
      out.author = authorLink.innerText.replace(/作者/g, '').trim() || null;
      if (!out.author) {
        // 文本为空就取 img alt
        const img = authorLink.querySelector('img[alt]');
        out.author = img?.getAttribute('alt') || null;
      }
    }

    return out;
  });

  if (!meta.title) fail('标题未抓到', 'detail-video-info 容器为空或无 h1');
  if (!meta.author) log('WARN', '作者未抓到（不影响继续）');
  if (!meta.publishTime) log('WARN', '发布时间未抓到');

  // --- 章节列表（HH:MM 模式）---
  const chapters = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('li, div, span, p'))
      .map(e => (e.innerText || '').trim())
      .filter(t => /^\d{2}:\d{2}\s+\S/.test(t))
      .map(t => t.split('\n').slice(0, 2).join(' | '))
      .filter((v, i, a) => a.indexOf(v) === i);
    return items.slice(0, 25);
  });
  log('INFO', `章节: ${chapters.length} 条`);

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
      const items = Array.from(document.querySelectorAll('[class*="comment-mainContent"]'));
      return items.slice(0, max).map(item => {
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
    if (comments.length === 0) log('WARN', '评论未抓到（可能未登录或视频无评论）');
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
    url: meta.url,
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
    `original_url: "${data.url || ''}"`,
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
  blocks.push(`| 原始链接 | ${data.url} |`);
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
  blocks.push('```', `[INFO] 导航: ${data.url}`, `[INFO] 章节: ${data.chapters.length} 条`, `[INFO] 评论: ${data.comments.length} 条`, `[INFO] 字幕: 未获取`, `[INFO] 抓取完成: ${now.toISOString()}`, '```', '');

  return frontmatter + blocks.join('\n');
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

    // 抓取
    data = await scrapeDouyinPage(page, url);

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

    fs.writeFileSync(filepath, buildMarkdown(data), 'utf8');
    log('SUCCESS', `已保存: ${filepath}`);

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
