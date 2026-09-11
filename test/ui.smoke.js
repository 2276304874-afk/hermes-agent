#!/usr/bin/env node
'use strict';
/* =============================================================================
 * test/ui.smoke.js —— 前端浏览器冒烟测试（无头 Chrome）
 *
 * 为什么需要它：2026-09-11 前端从 index.html 单文件拆成 index.html + app.css +
 * app.js 三个文件。拆分前 1400 行内联脚本躺在 HTML 里，node --check 够不着；
 * 拆分后虽然能过语法检查，但「CSS 真加载了吗 / JS 真跑起来了吗 / 页面有没有
 * 一上来就抛错」这三件事仍然只有肉眼能验。这个脚本把它们变成可重复的断言。
 *
 * 判据分五层（缺一层都不算通过）：
 *   L1 传输层：/ 返回 200、/app.css 与 /app.js 可获取且 MIME 正确
 *   L2 执行层：app.js 真的执行了（window.__UI_VERSION__ 被服务端替换成数值）
 *   L3 渲染层：CSS 变量生效、关键 DOM 存在且有尺寸
 *   L4 健康层：加载与初始化期间零 pageerror、零 console.error
 *   L5 降级层：拦截 /api/sessions 返回 degraded，告警必须出现且不阻断列表（P1-4）
 *   L6 KB 页层：/kb 带令牌可渲染、搜索按 {results:[]} 形状渲染、无令牌须提示补填（P2-10）
 *
 * 用法：
 *   node test/ui.smoke.js [port] [token]
 *   node test/ui.smoke.js 4173 "$(cat ~/.hermes/ui_token)"
 *
 * 依赖 playwright-core + 本机已装的 Chrome。二者缺一时打印 SKIP 并以 0 退出
 * （不阻断流水线），但会明确标注"前端未经验证"，避免造成虚假的安全感。
 * ========================================================================== */

const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || '4173';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.argv[3] || process.env.HERMES_TOKEN || '';
const SHOT = process.env.UI_SMOKE_SHOT || '/tmp/hermes-ui-smoke.png';

/* ---------- playwright-core 解析（多路兜底，不硬编码版本目录） ---------- */
function loadPlaywright() {
  try { return require('playwright-core'); } catch { /* 继续找 */ }
  try { return require('playwright'); } catch { /* 继续找 */ }
  // 托管 node workspace 兜底
  const home = process.env.HOME || os.homedir();
  const ws = path.join(home, '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'playwright-core');
  try { return require(ws); } catch { /* 放弃 */ }
  return null;
}

/* ---------- Chrome 可执行文件探测 ---------- */
function findChrome() {
  const cands = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
  return cands.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

/* ---------- 断言收集 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(name, detail) { pass++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
function bad(name, detail) { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
function check(cond, name, detail) { cond ? ok(name, detail) : bad(name, detail); }

/* 这些 console 错误属于预期噪声，不算前端故障 */
const CONSOLE_WHITELIST = [
  /favicon\.ico/i,           // 本项目没放 favicon，Chrome 会主动请求并拿到 404
  /net::ERR_ABORTED/i,       // 页面卸载/重载时被主动中断的请求
];

(async () => {
  const pw = loadPlaywright();
  if (!pw) {
    console.log('⚠️  SKIP：未找到 playwright-core，前端未经验证。');
    console.log('    安装后可用：npm i -D playwright-core（本机已装 Chrome 即可，无需下浏览器）');
    process.exit(0);
  }
  const chrome = findChrome();
  if (!chrome) {
    console.log('⚠️  SKIP：未找到本机 Chrome/Chromium，前端未经验证。');
    process.exit(0);
  }

  console.log(`前端冒烟测试 → ${BASE}`);
  const appName = (chrome.match(/\/([^/]+)\.app\//) || [])[1];
  console.log(`  浏览器: ${appName || path.basename(chrome)}`);
  console.log('');

  let browser;
  try {
    browser = await pw.chromium.launch({ executablePath: chrome, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    // 注入 token，让页面跳过登录遮罩直接渲染主界面
    await ctx.addInitScript(([tok]) => {
      try {
        if (tok) localStorage.setItem('hermes_ui_token', tok);
        localStorage.setItem('hermes_ui_theme', 'light');
      } catch (e) {}
    }, [TOKEN]);

    const page = await ctx.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const badResponses = [];
    page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      // 资源类报错的文本里不含 URL（只有"Failed to load resource ... 404"），
      // 必须把 location().url 一起带上才能正确归因，否则 favicon 的 404 会被误判成前端故障。
      let loc = '';
      try { loc = (m.location() && m.location().url) || ''; } catch (e) {}
      consoleErrors.push({ text: m.text(), url: loc });
    });
    page.on('response', r => {
      const u = r.url();
      if (r.status() >= 400 && !/favicon\.ico/.test(u)) badResponses.push(`${r.status()} ${u}`);
    });

    /* ---------- L1 传输层 ---------- */
    console.log('L1 传输层');
    const resp = await page.goto(BASE + '/', { waitUntil: 'load', timeout: 20000 });
    check(resp && resp.status() === 200, '/ 返回 200', resp ? `HTTP ${resp.status()}` : '无响应');
    check((await page.title()).includes('赫尔墨斯特工'), '页面标题正确', await page.title());

    const assets = await page.evaluate(async () => {
      const out = [];
      for (const u of ['/app.css', '/app.js']) {
        try {
          const r = await fetch(u);
          out.push({ u, status: r.status, ct: r.headers.get('content-type') || '', len: (await r.text()).length });
        } catch (e) { out.push({ u, status: 0, ct: '', len: 0, err: String(e) }); }
      }
      return out;
    });
    for (const a of assets) {
      check(a.status === 200, `${a.u} 可获取`, `HTTP ${a.status}, ${a.len} 字节`);
      const want = a.u.endsWith('.css') ? 'text/css' : 'text/javascript';
      check(a.ct.includes(want), `${a.u} MIME 正确`, a.ct);
    }

    /* ---------- L2 执行层 ---------- */
    console.log('L2 执行层');
    const ver = await page.evaluate(() => window.__UI_VERSION__);
    check(!!ver && ver !== '__UI_VERSION__', 'app.js 已执行 & 版本戳被服务端替换', String(ver));

    /* ---------- L3 渲染层 ---------- */
    console.log('L3 渲染层');
    const css = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        bgVar: cs.getPropertyValue('--bg').trim(),
        accentVar: cs.getPropertyValue('--accent').trim(),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        sheets: document.styleSheets.length,
      };
    });
    check(!!css.bgVar && !!css.accentVar, 'app.css 已加载（主题变量可读）', `--bg=${css.bgVar} --accent=${css.accentVar} (${css.sheets} 张样式表)`);
    check(css.bodyBg && css.bodyBg !== 'rgba(0, 0, 0, 0)', 'body 背景色已应用', css.bodyBg);

    const REQUIRED = ['messages', 'input', 'sendBtn', 'modelSelect', 'sessList', 'loginMask', 'tabBody', 'kbBtn'];
    const dom = await page.evaluate((ids) => ids.map(id => {
      const el = document.getElementById(id);
      if (!el) return { id, exists: false };
      const r = el.getBoundingClientRect();
      return { id, exists: true, w: Math.round(r.width), h: Math.round(r.height) };
    }), REQUIRED);
    for (const d of dom) {
      check(d.exists, `#${d.id} 存在`, d.exists ? `${d.w}×${d.h}` : '未找到');
    }
    // 主容器必须真的有尺寸（防"CSS 没生效导致全部塌成 0×0"）
    const msgBox = dom.find(d => d.id === 'messages');
    check(msgBox && msgBox.h > 100, '#messages 有实际高度（布局生效）', msgBox ? `${msgBox.h}px` : 'n/a');

    // 登录遮罩应因注入了 token 而隐藏
    const maskHidden = await page.evaluate(() => {
      const el = document.getElementById('loginMask');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden' || el.hidden || Number(cs.opacity) === 0;
    });
    check(maskHidden === true, '注入 token 后登录遮罩已隐藏', String(maskHidden));

    /* ---------- L4 健康层 ---------- */
    console.log('L4 健康层');
    // 给异步初始化（loadSessions/loadModels/refreshStatus）留出时间
    await page.waitForTimeout(2500);
    check(pageErrors.length === 0, '无 JS 运行时错误 (pageerror)', pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '');

    const realConsoleErrors = consoleErrors.filter(c => !CONSOLE_WHITELIST.some(re => re.test(c.text) || re.test(c.url)));
    check(realConsoleErrors.length === 0, '无 console.error', realConsoleErrors.length
      ? realConsoleErrors.slice(0, 3).map(c => `${c.text} @ ${c.url || '(无 URL)'}`).join(' | ') : '');
    check(badResponses.length === 0, '无 4xx/5xx 资源请求', badResponses.length ? badResponses.slice(0, 3).join(' | ') : '');

    /* ---------- L5 降级分支（P1-4） ---------- */
    // /api/sessions 返回 degraded 时，会话列表区必须出现"疑似格式变更"告警且仍照常渲染。
    // 正常态永远测不到这个分支（后端只在 CLI 输出格式变更时才给标记），故用路由拦截构造响应。
    console.log('L5 降级分支');
    await page.route('**/api/sessions', r => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions: [], degraded: true, warning: 'sessions list 输出疑似格式变更' }),
    }));
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const sessText = await page.$eval('#sessList', el => el.textContent).catch(() => '');
    check(/疑似格式变更/.test(sessText), 'degraded 时显示解析告警', sessText.slice(0, 50));
    check(/暂无历史会话/.test(sessText), 'degraded 不阻断列表渲染（不白屏）', '');
    check(pageErrors.length === 0, '降级分支无 JS 运行时错误', pageErrors.length ? pageErrors.slice(0, 2).join(' | ') : '');
    // 还原真实响应，保证下面的截图反映的是正常态
    await page.unroute('**/api/sessions');
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1200);

    /* ---------- L6 KB 查看器（P2-10 认证 + 返回形状归一） ---------- */
    // 两件「页面打得开、但功能其实是空的」的故障，肉眼极难发现，故固化进冒烟网：
    //   ① KB 接口已移入认证闸门 → /kb 页面不带令牌时全是 401（页面本身仍 200，只是空）；
    //   ② /api/kb/list 返回数组、/api/kb/search 返回 {results:[]} —— 合并到 4173 后
    //      搜索分支直接对对象调 .map()，导致搜索永远显示"暂无内容"（本次修掉的真实 bug）。
    console.log('L6 KB 查看器');
    const kbErrorsBefore = pageErrors.length;
    await page.goto(`${BASE}/kb`, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const authHidden = await page.$eval('#authBar', el => el.hidden).catch(() => null);
    check(authHidden === true, '有令牌时不再提示补填', String(authHidden));
    const kbListText = await page.$eval('#list', el => el.textContent).catch(() => '');
    check(!/加载失败/.test(kbListText), 'KB 列表正常渲染（非 401/报错）', kbListText.slice(0, 30));

    // 用拦截构造 search 的**真实**形状（对象而非数组），锁死"形状归一"这处回归
    await page.route('**/api/kb/search*', r => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        query: 'launchd', count: 1,
        results: [{ cat: 'search', type: '经验', src: 'test.md', text: '形状归一回归样本', score: 0.9 }],
      }),
    }));
    await page.click('#nav button[data-cat="search"]');
    await page.fill('#q', 'launchd');
    await page.click('#searchRow button');
    await page.waitForTimeout(900);
    const searchText = await page.$eval('#list', el => el.textContent).catch(() => '');
    check(/形状归一回归样本/.test(searchText), '搜索结果按 {results:[]} 形状渲染', searchText.slice(0, 40));
    await page.unroute('**/api/kb/search*');

    // 反面：令牌无效时必须弹出补填提示，而不是静默显示空列表。
    // 注意：ctx.addInitScript 每次导航都会把正确令牌重新写进 localStorage，
    // 所以这里改测"令牌错误 + 触发请求"——走的是同一条 401 → showAuthBar 路径，
    // 比单纯清 localStorage 更贴近真实故障（用户在另一台机器/换了令牌）。
    await page.evaluate(() => localStorage.setItem('hermes_ui_token', 'wrong-token-for-smoke'));
    await page.click('#nav button[data-cat="all"]');
    await page.waitForTimeout(900);
    const authShown = await page.$eval('#authBar', el => el.hidden).catch(() => null);
    check(authShown === false, '令牌无效时提示补填令牌', String(authShown));
    check(pageErrors.length === kbErrorsBefore, 'KB 页面无 JS 运行时错误',
      pageErrors.length > kbErrorsBefore ? pageErrors.slice(kbErrorsBefore, kbErrorsBefore + 2).join(' | ') : '');

    // 恢复令牌并回到主界面，让末尾截图反映正常态
    await page.evaluate(t => localStorage.setItem('hermes_ui_token', t), TOKEN);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForTimeout(800);

    /* ---------- 截图存档 ---------- */
    try {
      await page.screenshot({ path: SHOT, fullPage: false });
      console.log(`\n  📷 截图: ${SHOT}`);
    } catch (e) { /* 截图失败不影响结论 */ }

    await browser.close();
  } catch (e) {
    bad('测试执行异常', String(e && e.message || e).split('\n')[0]);
    if (browser) { try { await browser.close(); } catch {} }
  }

  console.log('');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('失败项：');
    failures.forEach(f => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})();
