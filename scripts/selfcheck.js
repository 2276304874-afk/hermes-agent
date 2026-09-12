#!/usr/bin/env node
'use strict';
/* =============================================================================
 * scripts/selfcheck.js —— 网页文件自检（自检闭环的本地执行器）
 *
 * 用法：node scripts/selfcheck.js <html文件绝对路径> [超时秒，默认15]
 *
 * 行为：headless Chrome 加载 file:// 页面 → 采集
 *   - console.error / console.warn
 *   - 未捕获异常（pageerror）
 *   - 资源加载失败（404 的 js/css/img）
 *   - 整页截图 → <文件名>.selfcheck.png（与目标文件同目录）
 * 输出：stdout 一行 JSON：{ ok, errors:[], warnings:[], resources:[], screenshot }
 *   ok=true 表示零 error、零未捕获异常。agent 拿到 ok=false 时应修复后重跑。
 *
 * 依赖：playwright-core + 本机 Chrome（与 test/ui.smoke.js 同一解析策略）。
 * ============================================================================ */

const fs = require('fs');
const path = require('path');
const os = require('os');

function findPlaywright() {
  try { return require('playwright-core'); } catch { /* 继续 */ }
  try { return require('playwright'); } catch { /* 继续 */ }
  try { return require(path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright-core')); } catch { /* 继续 */ }
  return null;
}

function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}

async function main() {
  const target = path.resolve(process.argv[2] || '');
  const timeoutSec = Math.min(Number(process.argv[3]) || 15, 60);
  if (!target || !fs.existsSync(target)) {
    console.log(JSON.stringify({ ok: false, errors: ['文件不存在: ' + target], warnings: [], resources: [], screenshot: null }));
    process.exit(2);
  }
  const pw = findPlaywright();
  const chrome = findChrome();
  if (!pw || !chrome) {
    console.log(JSON.stringify({ ok: false, errors: ['未找到 playwright-core 或 Chrome，无法自检'], warnings: [], resources: [], screenshot: null }));
    process.exit(3);
  }

  const errors = [], warnings = [], resources = [];
  let browser = null;
  let screenshot = null;
  try {
    browser = await pw.chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 300));
      else if (m.type() === 'warning') warnings.push('console.warn: ' + m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => errors.push('uncaught: ' + String(e && e.message || e).slice(0, 300)));
    page.on('requestfailed', (r) => resources.push('failed: ' + r.url().slice(0, 200) + ' (' + (r.failure() && r.failure().errorText || '?') + ')'));
    page.on('response', (r) => { if (r.status() >= 400) resources.push('http ' + r.status() + ': ' + r.url().slice(0, 200)); });

    await page.goto('file://' + target, { waitUntil: 'load', timeout: timeoutSec * 1000 });
    await page.waitForTimeout(800);   // 留给异步渲染/懒加载
    const shotPath = target.replace(/\.html?$/i, '') + '.selfcheck.png';
    await page.screenshot({ path: shotPath, fullPage: false });
    screenshot = shotPath;
  } catch (e) {
    errors.push('load: ' + String(e && e.message || e).slice(0, 300));
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }

  const result = { ok: errors.length === 0, errors, warnings, resources, screenshot };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main();
