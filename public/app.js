/* =============================================================================
 * public/app.js —— 赫尔墨斯特工前端主逻辑
 *
 * 2026-09-11 从 index.html 末尾的 <script> 块原样抽出（P1-3 第四步：前端拆分）。
 * 整体是一个 IIFE，零内容改动，逐字搬迁。
 *
 * 为什么这么抽：
 *  - 抽成独立文件后 `node --check public/app.js` 可用 —— 前端从「零自动化网」
 *    变成「至少有语法网」的关键一步（此前 1400 行内联脚本无人校验）。
 *  - 仍保留 IIFE，不改 ES module：module 会变严格模式且顶层 import/export 语义变化，
 *    属于"顺手改行为"，不做。
 *
 * ⚠️ 不变量（改动时别破坏）：
 *  - 引用位置必须是 body 末尾的 <script src="/app.js"></script>，**不加 defer/async**。
 *  - 服务端对该文件发 Cache-Control: no-cache；`/api/health` 的 uiVersion 取
 *    public/ 目录内所有文件的最大 mtime，故改本文件也会触发"界面已更新"提示条。
 * ========================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages'), inputEl = $('input'), sendBtn = $('sendBtn');
  const modelSelect = $('modelSelect'), sessListEl = $('sessList'), hintEl = $('hint');
  const loginMask = $('loginMask'), tokenInput = $('tokenInput'), tokenSubmit = $('tokenSubmit');
  const approvalMask = $('approvalMask'), blockedCmdEl = $('blockedCmd');
  const approvalAllow = $('approvalAllow'), approvalDeny = $('approvalDeny');
  let sessionId = null, currentRunId = null, busy = false, currentRunEl = null;
  let lastPrompt = '';        // 最近一次发送的 prompt，用于审批后重跑
  let blockedCommand = '';    // 最近被拦截的命令，展示在审批弹窗
  let pendingAllowDangerous = false; // 审批通过后的重跑标记
  /* dsh 式工作区（2026-09-12）：activeWs='' 表示「全部/未选」；wsModOn = 输入卡内「工作区内修改」开关（= allowDangerous） */
  let wsList = [], wsAssign = {}, activeWs = '';
  let wsModOn = false;

  /* ---------- P1-5 静默 catch 治理 ----------
   * 规范：catch 里"什么都不做"会让故障看起来像"功能本来就没有"——模型下拉空了、
   * 设置面板一片空白，用户无从判断是真没有还是坏了。分级处置：
   *   · softFail  —— 可忽略的降级路径（清理、偏好读写、可选增强），console.debug 留痕。
   *                  浏览器控制台**不写** launchd 捕获的日志文件，没有刷屏风险，故可放心留痕。
   *   · console.warn + 界面可见提示 —— 会让用户困惑的失败（列表拉不到、模型拉不到）。
   * 确实属于正常分支的（如工具输出本来就不是 JSON）留注释说明，不留痕，避免噪声。 */
  function softFail(where, e) {
    console.debug('[hermes] ' + where + ' 失败（已降级，可忽略）:', (e && e.message) || e || '');
  }

  /* ---------- B8 亮/暗主题 ---------- */
  const themeBtn = $('themeBtn');
  const SVG_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21.5" y2="12"/><line x1="5.3" y1="5.3" x2="7" y2="7"/><line x1="17" y1="17" x2="18.7" y2="18.7"/><line x1="5.3" y1="18.7" x2="7" y2="17"/><line x1="17" y1="7" x2="18.7" y2="5.3"/></svg>';
  const SVG_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  function applyTheme(t, persist) {
    document.documentElement.dataset.theme = t;
    themeBtn.innerHTML = t === 'dark' ? SVG_SUN : SVG_MOON;
    themeBtn.title = t === 'dark' ? '切换到亮色主题' : '切换到暗色主题';
    if (persist) { try { localStorage.setItem('hermes_ui_theme', t); } catch (e) { softFail('保存主题偏好', e); } }
  }
  themeBtn.onclick = () => {
    const cur = document.documentElement.dataset.theme || 'dark';
    applyTheme(cur === 'dark' ? 'light' : 'dark', true);
  };
  // 与 head 脚本同步：无偏好默认暗色
  applyTheme((document.documentElement.dataset.theme || 'dark'), false);

  /* ---------- B7 思考块显示控制 ----------
   * 2026-09-12 更名：原称「快速/思考 模式」，但该开关**从不改变请求参数** —— 本地模型的
   * 思维链与回答属于同一次推理，折叠它既不省时间也不省 token，因此「快速」属误导。
   * 变量内部仍沿用 chatMode/'fast'/'think'，避免动 localStorage key 与既有行为。
   * ⚠️ 刻意保持不随请求下传：本地小模型关闭 CoT 会退化成「只说不做」（工具调用失灵）。 */
  const modeSeg = $('modeSeg');
  let chatMode = 'think';   // 'fast' 折叠思考块；'think' 展开
  try { chatMode = localStorage.getItem('hermes_ui_mode') || 'think'; } catch (e) { softFail('读取模式偏好', e); }
  function setMode(m) {
    chatMode = m;
    for (const b of modeSeg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === m);
    try { localStorage.setItem('hermes_ui_mode', m); } catch (e) { softFail('保存模式偏好', e); }
    // 切换后：fast 折叠已有思考块，think 展开（跨轮保持）
    for (const r of document.querySelectorAll('.reason')) r.classList.toggle('open', m === 'think');
  }
  modeSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (b && b.dataset.mode) setMode(b.dataset.mode);
  });
  setMode(chatMode);

  /* ---------- L3 真流式状态 ---------- */
  let liveText = '';          // 当前 token 流累积
  let tokenIgnore = false;    // 最终回答已渲染后忽略迟到 token
  let renderTimer = null;     // markdown 节流渲染
  let curStats = null;        // done 事件带来的速度统计

  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  /* ---------- Token 认证 ---------- */
  function getToken() { return localStorage.getItem('hermes_ui_token') || ''; }
  function setToken(t) { localStorage.setItem('hermes_ui_token', t); }
  function showLogin() { loginMask.classList.add('show'); tokenInput.focus(); }
  function hideLogin() { loginMask.classList.remove('show'); }
  function authHeaders(extra) {
    const h = { ...(extra || {}) };
    const t = getToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }
  // 带认证的 fetch，401 自动弹登录
  async function apiFetch(url, opts) {
    const o = opts || {};
    o.headers = authHeaders(o.headers);
    const r = await fetch(url, o);
    if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
    return r;
  }
  tokenSubmit.onclick = async () => {
    const t = tokenInput.value.trim();
    if (!t) return;
    setToken(t);
    try {
      const r = await apiFetch('/api/auth');
      if (r.ok) { hideLogin(); loadSessions(); loadWorkspaces(); loadModels(); refreshStatus(); if (!messagesEl.querySelector('.empty-state') && !messagesEl.children.length) renderEmptyState(); }
      else { alert('令牌错误，请重试'); }
    } catch { /* 已弹登录 */ }
  };
  tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tokenSubmit.click(); });

  /* ---------- 代码高亮（轻量正则 tokenizer，离线可用） ---------- */
  const KEYWORDS = {
    js: 'const let var function return if else for while do class new import from export default async await try catch finally throw typeof instanceof null undefined true false this switch case break continue of in yield static get set extends super delete void',
    ts: 'const let function return if else for while class new import from export default async await try catch throw typeof interface type enum implements extends public private protected readonly null undefined true false this switch case break continue of in as never unknown any string number boolean void',
    python: 'def return if elif else for while import from class try except finally raise with as None True False and or not in is lambda pass yield global nonlocal assert del async await match case',
    bash: 'if then elif else fi for while do done case esac function in return exit export local echo read set unset shift source alias',
    json: 'true false null',
    go: 'func package import var const type struct interface map chan go defer if else for range return switch case default nil true false string int int64 float64 bool error',
    rust: 'fn let mut const struct enum impl trait pub use mod match if else for while loop return Some None Ok Err self super crate as dyn ref move async await where true false',
    sql: 'select from where insert into values update set delete create table drop alter index join left right inner outer on group by order having limit offset as and or not null distinct count sum avg min max'
  };
  const LANG_ALIAS = { javascript: 'js', jsx: 'js', typescript: 'ts', tsx: 'ts', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', golang: 'go', rs: 'rust', yml: 'yaml' };
  function highlightCode(code, lang) {
    const norm = LANG_ALIAS[lang] || lang;
    const kws = KEYWORDS[norm];
    const escaped = escapeHtml(code);
    if (!kws) return escaped; // 未知语言：不着色（仍是转义安全的）
    const kwSet = new Set(kws.split(' '));
    const re = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|#[^\n]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
    return escaped.replace(re, (m, str, com, num, word) => {
      if (str) return '<span class="tok-str">' + str + '</span>';
      if (com) return '<span class="tok-com">' + com + '</span>';
      if (num) return '<span class="tok-num">' + num + '</span>';
      if (word && kwSet.has(word)) return '<span class="tok-kw">' + word + '</span>';
      return m;
    });
  }

  /* ---------- Markdown 渲染（增强：标题/表格/引用/链接/删除线/高亮） ---------- */
  function renderMarkdown(raw) {
    const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
    let html = '', i = 0, listMode = null; // 'ul' | 'ol'
    const closeList = () => { if (listMode) { html += '</' + listMode + '>'; listMode = null; } };
    while (i < lines.length) {
      const line = lines[i];
      // 代码围栏
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        closeList(); let code = ''; i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { code += lines[i] + '\n'; i++; }
        i++;
        const lang = (fence[1] || '').toLowerCase();
        html += '<div class="code-wrap"><pre><code>' + highlightCode(code.replace(/\n$/, ''), lang) + '</code></pre>'
          + '<button class="copy-code-btn" type="button">复制</button></div>';
        continue;
      }
      // 表格（当前行含 | 且下一行是分隔行）
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
        closeList();
        const parseRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const head = parseRow(line);
        i += 2;
        let rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(parseRow(lines[i])); i++; }
        html += '<table><thead><tr>' + head.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>'
          + rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
        continue;
      }
      // 标题
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); const lv = Math.min(h[1].length + 1, 4); html += '<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>'; i++; continue; }
      // 水平线
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { closeList(); html += '<hr>'; i++; continue; }
      // 引用块
      if (/^\s*>\s?/.test(line)) {
        closeList(); let quote = '';
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote += lines[i].replace(/^\s*>\s?/, '') + '\n'; i++; }
        html += '<blockquote>' + renderMarkdown(quote.replace(/\n$/, '')) + '</blockquote>'; continue;
      }
      // 列表
      if (/^\s*[-*]\s+/.test(line)) {
        if (listMode !== 'ul') { closeList(); html += '<ul>'; listMode = 'ul'; }
        html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; i++; continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        if (listMode !== 'ol') { closeList(); html += '<ol>'; listMode = 'ol'; }
        html += '<li>' + inline(line.replace(/^\s*\d+\.\s+/, '')) + '</li>'; i++; continue;
      }
      closeList();
      if (line.trim() === '') { i++; continue; }
      html += '<p>' + inline(line) + '</p>'; i++;
    }
    closeList(); return html;
  }
  function inline(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  function addUserMsg(text, imgUrl) {
    const msg = document.createElement('div'); msg.className = 'msg user';
    msg.dataset.raw = text;
    const imgHtml = imgUrl ? '<img class="msg-img" src="' + imgUrl + '" alt="附图" />' : '';
    msg.innerHTML = '<div class="avatar">你</div><div class="col"><div class="bubble">' + imgHtml + escapeHtml(text) + '</div>'
      + '<div class="msg-acts">'
      + '<button type="button" data-act="edit" title="填回输入框修改后重发">✏️ 编辑重发</button>'
      + '<button type="button" data-act="copy">复制</button></div></div>';
    messagesEl.appendChild(msg); scrollDown();
  }
  function addNote(text, cls) {
    const note = document.createElement('div'); note.className = 'sysnote' + (cls ? ' ' + cls : '');
    note.textContent = text; messagesEl.appendChild(note); scrollDown(); return note;
  }
  /* ---------- /kb 知识库召回命令 ---------- */
  function addKbCards(query, hits, errMsg) {
    const msg = document.createElement('div'); msg.className = 'msg bot';
    const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = '库';
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    let html = '<div class="kb-block"><div class="kb-head">本地知识库召回 <span class="tag">/kb ' + escapeHtml(query) + '</span></div>';
    if (errMsg != null) {
      html += '<div class="kb-empty">检索失败：' + escapeHtml(errMsg) + '</div>';
    } else if (!hits || !hits.length) {
      html += '<div class="kb-empty">未找到与「' + escapeHtml(query) + '」相关的知识库条目（可换关键词再试，或让系统继续捕获/蒸馏）。</div>';
    } else {
      for (const h of hits) {
        const sc = (h.score != null) ? '<span class="kb-score">相关度 ' + h.score + '</span>' : '';
        html += '<div class="kb-card"><div class="kb-meta">'
          + '<span class="kb-badge">' + escapeHtml(h.section || '经验') + '</span>'
          + '<span class="kb-src">' + escapeHtml(h.source || '') + '</span>' + sc
          + '</div><div class="kb-text">' + escapeHtml(h.text || '') + '</div></div>';
      }
    }
    html += '</div>';
    bubble.innerHTML = html;
    msg.appendChild(avatar); msg.appendChild(bubble);
    messagesEl.appendChild(msg); scrollDown();
  }
  async function runKb(query) {
    if (!query) { addNote('用法：/kb <关键词>，例如 /kb 首字延迟'); return; }
    inputEl.value = ''; inputEl.style.height = 'auto';
    const es0 = messagesEl.querySelector('.empty-state'); if (es0) es0.remove();
    addUserMsg('/kb ' + query);
    const note = addNote('🔍 正在检索本地知识库…');
    try {
      const r = await apiFetch('/api/kb?q=' + encodeURIComponent(query));
      const data = await r.json();
      note.remove();
      addKbCards(query, data.hits || []);
    } catch (e) {
      note.remove();
      addKbCards(query, null, e.message);
    }
  }
  /* ---------- T2 执行轨迹（Trajectory） ----------
   * 本地模型一轮里有 10~20 秒是纯等待（system prompt prefill），此前界面只有一句
   * 「思考中…」，用户无法判断是在干活还是卡死。这里把已观测到的事件映射成阶段，
   * 并对**当前阶段实时跳秒**：把无从判断的等待变成看得见的进展。
   *
   * 设计约束（务必遵守）：
   *   ① 阶段是对 Hermes 内部状态的**推测性映射**，文案不得谎称精确 —— 不显示百分比，
   *      不预测剩余时间（本地推理耗时受 prompt 长度影响极大，任何预测都会失准）。
   *   ② 只增不改：不动 createRunPanel 之外的结构，也不接管 tool-timeline / reason 的渲染。
   *   ③ 计时器必须随本轮结束清理，否则快速多轮会泄漏 interval。
   */
  const TRAJ_STEPS = [
    ['ready', '建立连接'],
    ['session', '准备上下文'],
    ['think', '模型推理'],
  ];

  function createRunPanel() {
    const msg = document.createElement('div'); msg.className = 'msg bot';
    const run = document.createElement('div'); run.className = 'run has-traj';
    run.innerHTML = '<div class="traj">'
      + TRAJ_STEPS.map((s, i) => '<div class="traj-step' + (i === 0 ? ' running' : '') + '" data-step="' + s[0] + '">'
        + '<i class="traj-ic"></i><span class="traj-lb">' + s[1] + '</span><b class="traj-t">—</b></div>').join('')
      + '</div><span class="thinking">思考中<span class="dots"></span></span><div class="tool-timeline"></div><div class="answer"></div>';
    msg.innerHTML = '<div class="avatar">H</div><div class="bubble"></div>';
    msg.querySelector('.bubble').appendChild(run);
    messagesEl.appendChild(msg); scrollDown();

    run._trajT0 = Date.now();
    // 100ms 刷新：肉眼足够连贯，又不至于频繁重排
    run._trajTimer = setInterval(() => {
      const cur = run.querySelector('.traj-step.running .traj-t');
      if (cur) cur.textContent = fmtSec(Date.now() - run._trajT0);
    }, 100);
    return run;
  }

  /** 推进到指定阶段：其之前的全部标记完成，目标阶段开工并开始跳秒。被调用多次也幂等。 */
  function trajAdvance(run, step) {
    if (!run || !run.isConnected) return;
    const now = Date.now();
    const elapsed = fmtSec(now - (run._trajT0 || now));
    const rows = [...run.querySelectorAll('.traj-step')];
    let seen = false;
    for (const r of rows) {
      if (r.dataset.step === step) { seen = true; break; }
      r.classList.remove('running'); r.classList.add('done');
      const t = r.querySelector('.traj-t');
      if (t && t.textContent === '—') t.textContent = elapsed;
    }
    if (!seen) return;                     // 未知阶段：不制造没观测到的假象
    const target = rows.find(r => r.dataset.step === step);
    target.classList.add('running');
    const tt = target.querySelector('.traj-t');
    if (tt) tt.textContent = elapsed;
  }

  /** 本轮收尾：停表并把未完成的阶段标记为已完成（中断/完成都不该留一个卡住的转圈）。 */
  function trajFinish(run, ok) {
    if (!run) return;
    if (run._trajTimer) { clearInterval(run._trajTimer); run._trajTimer = null; }
    const elapsed = fmtSec(Date.now() - (run._trajT0 || Date.now()));
    for (const r of run.querySelectorAll('.traj-step')) {
      const t = r.querySelector('.traj-t');
      if (r.classList.contains('running')) {
        r.classList.remove('running');
        r.classList.add(ok === false ? 'aborted' : 'done');
        if (t) t.textContent = elapsed;
      } else if (t && t.textContent === '—') t.textContent = '—';
    }
  }

  function fmtSec(ms) { return (Math.max(0, ms) / 1000).toFixed(1) + 's'; }
  function hideThinking(run) { const t = run.querySelector('.thinking'); if (t) t.style.display = 'none'; }
  // C3: 把模型 reasoning（深度思考）渲染成可折叠块，插在 tool-timeline 之前
  // B7: 快速模式下新块默认折叠（chatMode==='fast' 时只收一条），思考模式默认展开
  function appendReasoning(run, text) {
    text = String(text || '').trim();
    if (!text) return;
    hideThinking(run);
    let r = run.querySelector('.reason');
    if (!r) {
      r = document.createElement('div');
      r.className = 'reason' + (chatMode === 'think' ? ' open' : '');
      r.innerHTML = '<div class="reason-head"><span class="arr">▶</span><span>深度思考</span></div><div class="reason-body"></div>';
      r.querySelector('.reason-head').onclick = () => r.classList.toggle('open');
      run.insertBefore(r, run.querySelector('.tool-timeline'));
      scrollDown();
    }
    const body = r.querySelector('.reason-body');
    if (body.textContent.trim()) body.textContent += '\n\n——\n\n';
    body.textContent += text;
    scrollDown();
  }
  // L5: 回答完成后的操作条（重新生成 / 朗读）
  function appendBotActs(run) {
    if (!run || run.querySelector('.bot-acts')) return;
    const ans = run.querySelector('.answer');
    if (!ans || !ans.textContent.trim()) return;
    const bar = document.createElement('div'); bar.className = 'msg-acts bot-acts';
    bar.innerHTML = '<button type="button" data-act="regen">🔄 重新生成</button>'
      + '<button type="button" data-act="speak">🔊 朗读</button>';
    run.appendChild(bar);
  }
  // B6: 长任务完成提醒（页面在后台时弹系统通知 + 短提示音）
  let notifAsked = false;
  function notifyDone(elapsed) {
    const sec = Math.round(parseFloat(elapsed) || 0);
    try {
      // 提示音（WebAudio，免音频文件）
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.12, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.35);
    } catch (e) { softFail('完成提示音', e); }   // 提示音失败不影响"完成"本身
    // 系统通知：仅页面不可见时弹，避免打扰；首次触发请求权限
    try {
      if ('Notification' in window) {
        if (Notification.permission === 'granted') {
          if (document.hidden) new Notification('赫尔墨斯特工 · 任务完成', { body: '用时 ' + sec + 's' });
        } else if (Notification.permission === 'default' && !notifAsked && document.hidden) {
          notifAsked = true;
          Notification.requestPermission().then(p => { if (p === 'granted' && document.hidden) new Notification('赫尔墨斯特工 · 任务完成', { body: '用时 ' + sec + 's' }); });
        }
      }
    } catch (e) { softFail('系统通知', e); }   // 通知权限/构造失败，不影响主流程
  }
  function setAnswer(run, text, streaming) {
    const ans = run.querySelector('.answer');
    ans.classList.toggle('streaming', !!streaming);
    ans.innerHTML = renderMarkdown(text);
    if (streaming) scrollDown();
  }
  // token 节流渲染（80ms），避免每 token 全量重排
  function scheduleLiveRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (currentRunEl && !tokenIgnore && liveText) setAnswer(currentRunEl, liveText, true);
    }, 80);
  }

  // 工具卡片：宣布时以 pending 占位（含命令），结果到达后回填同一张卡
  function appendToolCard(run, info) {
    const tl = run.querySelector('.tool-timeline');
    const card = document.createElement('div');
    card.className = 'tool-card' + (info.pending ? ' pending' : '');
    const icon = info.toolName === 'terminal' ? '🔧'
      : info.toolName === 'read_file' ? '📄'
      : info.toolName === 'write_file' ? '✏️' : '🛠️';
    let html = '<div class="tool-head">' + icon + ' ' + escapeHtml(info.toolName) + '</div>';
    if (info.cmd) html += '<div class="tool-cmd">' + (info.toolName === 'terminal' ? '$ ' : '') + escapeHtml(info.cmd) + '</div>';
    html += '<pre class="tool-out">' + (info.pending
      ? '<span class="run-dot">执行中</span>'
      : escapeHtml(String(info.out == null ? '' : info.out).slice(0, 3000))) + '</pre>';
    card.innerHTML = html;
    tl.appendChild(card); scrollDown();
  }
  // assistant 宣布调用工具（toolCalls 是 JSON 字符串）→ 渲染 pending 卡片
  function renderToolIntents(run, toolCallsJson) {
    let arr = null;
    try { arr = JSON.parse(toolCallsJson); } catch { return; }
    if (!Array.isArray(arr)) arr = [arr];
    for (const c of arr) {
      const f = c.function || c;
      const name = f.name || 'tool';
      let args = f.arguments, cmd = '';
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
      if (args && typeof args === 'object') cmd = args.command || args.path || args.file_path || args.input || '';
      appendToolCard(run, { toolName: name, cmd: String(cmd || ''), out: '', pending: true });
    }
  }
  // 判断工具结果是否为安全拦截
  function isBlockedResult(out) {
    const s = String(out || '');
    return s.indexOf('安全拦截') !== -1;
  }
  // role=tool 结果到达 → 回填最近一张 pending 卡；无 pending 则追加一张
  function fillToolResult(run, out) {
    const blocked = isBlockedResult(out);
    const pend = run.querySelectorAll('.tool-card.pending');
    if (pend.length) {
      const card = pend[pend.length - 1];
      card.querySelector('.tool-out').textContent = String(out).slice(0, 3000);
      card.classList.remove('pending');
      if (blocked) card.classList.add('blocked');
    } else {
      appendToolCard(run, { toolName: 'tool', cmd: '', out, pending: false });
      if (blocked) {
        const cards = run.querySelectorAll('.tool-card');
        cards[cards.length - 1].classList.add('blocked');
      }
    }
    // 拦截到危险命令 → 弹出审批
    if (blocked) {
      // 从拦截消息里提取命令文本（"安全拦截（原因）: 命令"）
      const m = String(out).match(/安全拦截[^:]*：?\s*(.+)$/);
      blockedCommand = m ? m[1] : String(out).slice(0, 120);
      showApproval();
    }
    scrollDown();
  }
  /* ---------- 危险操作审批 ---------- */
  function showApproval() {
    blockedCmdEl.textContent = blockedCommand;
    approvalMask.classList.add('show');
  }
  function hideApproval() { approvalMask.classList.remove('show'); }
  approvalDeny.onclick = () => { hideApproval(); };
  approvalAllow.onclick = () => {
    hideApproval();
    pendingAllowDangerous = true;
    // 用同一 prompt 重跑，allowDangerous=true
    if (lastPrompt) send(lastPrompt, true);
  };
  function extractToolOutput(content) {
    let out = content || '';
    try { const c = JSON.parse(out); if (c && typeof c === 'object') {
      if (c.output != null) out = String(c.output);
      else if (c.content != null) out = String(c.content);
      else if (c.error) out = '错误: ' + String(c.error);
      else out = JSON.stringify(c, null, 1);
    } } catch { /* 工具输出本就不是 JSON（纯文本/空）→ 原样展示。正常分支，留痕只会刷噪声 */ }
    return out;
  }

  function setBusy(state) {
    // 忙碌时不 disable 发送键：豆包式圆形按钮此时是"停止"，必须可点击才能取消
    busy = state;
    const SVG_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5.5"/><polyline points="6.5,11 12,5.5 17.5,11"/></svg>';
    const SVG_STOP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7.5" y="7.5" width="9" height="9" rx="1.5"/></svg>';
    if (state) { sendBtn.innerHTML = SVG_STOP; sendBtn.title = '取消'; sendBtn.classList.add('cancel'); }
    else { sendBtn.innerHTML = SVG_UP; sendBtn.title = '发送'; sendBtn.classList.remove('cancel'); }
  }
  function updateHint() {
    let s = sessionId ? ('当前会话: ' + sessionId) : '新会话（发送后将建立 Hermes 会话）';
    if (curStats) {
      s = `完成 · 首字 ${curStats.firstTokenMs || '-'}s` + (curStats.charsPerSec ? ` · ~${curStats.charsPerSec} tok/s` : '') + ` · ${curStats.elapsed}s`;
    }
    hintEl.textContent = s;
  }

  /* ---------- 云端 provider 设置 ---------- */
  const settingsMask = $('settingsMask'), provPreset = $('provPreset'), provModel = $('provModel'),
        provKey = $('provKey'), provBase = $('provBase'), provListEl = $('provList');
  let presets = {};
  let selectedProviderId = '';
  async function openSettings() {
    settingsMask.classList.add('show');
    await loadProviderSettings();
  }
  $('settingsBtn').onclick = openSettings;
  // 工作台改版：侧栏底部设置入口复用同一面板
  if ($('sideSettings')) $('sideSettings').onclick = openSettings;
  $('settingsClose').onclick = () => settingsMask.classList.remove('show');
  async function loadProviderSettings() {
    try {
      const r = await apiFetch('/api/providers'); const data = await r.json();
      presets = data.presets || {};
      // 预设下拉
      provPreset.innerHTML = '';
      for (const [id, p] of Object.entries(presets)) {
        const opt = document.createElement('option'); opt.value = id; opt.textContent = p.label;
        provPreset.appendChild(opt);
      }
      renderProvList(data.providers || {});
      const first = Object.keys(presets)[0] || '';
      if (!selectedProviderId && first) { provPreset.value = first; fillPresetForm(first); }
    } catch (e) {
      // 关键路径：这里静默会让「设置面板一片空白」看起来像「本就没配过接口」。
      // 与 P1-4 同一条原则 —— 失败必须看得见。
      console.warn('[hermes] 加载云端接口设置失败:', e);
      provListEl.innerHTML = '<p style="color:var(--danger, #c0392b);">接口列表加载失败：'
        + escapeHtml(e.message || String(e)) + '（服务未启动或令牌失效）</p>';
    }
  }
  function renderProvList(providers) {
    provListEl.innerHTML = '';
    const ids = Object.keys(providers);
    if (!ids.length) { const p = document.createElement('p'); p.textContent = '尚未配置云端接口，全部请求走本地离线模型。'; provListEl.appendChild(p); }
    for (const [id, p] of ids.map(id => [id, providers[id]])) {
      const el = document.createElement('div'); el.className = 'prov-item';
      const dotCls = !p.health ? '' : (p.health.ok ? ' ok' : ' bad');
      const dotTitle = !p.health ? '未检测' : (p.health.ok ? '可达 ' + p.health.latencyMs + 'ms' : p.health.error);
      el.innerHTML = `<span class="dot${dotCls}" title="${escapeHtml(dotTitle)}"></span>`
        + `<span class="nm">${escapeHtml(p.label)}</span>`
        + `<span class="models">${escapeHtml((p.models || []).join(', '))}</span>`
        + `<span class="models">${escapeHtml(p.apiKeyMasked)}</span>`;
      el.style.cursor = 'pointer';
      el.onclick = () => { selectedProviderId = id; provPreset.value = id; fillPresetForm(id, providers[id]); };
      provListEl.appendChild(el);
    }
  }
  function fillPresetForm(id, cfg) {
    const p = presets[id] || {};
    provModel.value = cfg && cfg.models ? cfg.models.join(',') : '';
    provKey.value = '';
    provKey.placeholder = cfg && cfg.hasKey ? `API Key（已存 ${cfg.apiKeyMasked}，留空保留）` : 'API Key';
    provBase.value = cfg && cfg.baseUrl ? cfg.baseUrl : (p.base || '');
  }
  provPreset.onchange = () => fillPresetForm(provPreset.value);
  $('provSave').onclick = async () => {
    const id = provPreset.value;
    const models = provModel.value.split(',').map(s => s.trim()).filter(Boolean);
    if (!models.length) { alert('请至少填写一个模型名'); return; }
    const body = { id, models, baseUrl: provBase.value.trim() };
    if (provKey.value.trim()) body.apiKey = provKey.value.trim();
    try {
      const r = await apiFetch('/api/providers/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) { alert(data.error || '保存失败'); return; }
      selectedProviderId = id;
      await loadProviderSettings(); await loadModels();
    } catch (e) { alert('保存失败: ' + e.message); }
  };
  $('provDelete').onclick = async () => {
    const id = provPreset.value;
    if (!confirm('删除接口 ' + (presets[id] || {}).label + '？')) return;
    try {
      await apiFetch('/api/providers/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      selectedProviderId = '';
      await loadProviderSettings(); await loadModels();
    } catch (e) { alert('删除失败: ' + e.message); }
  };
  $('provTest').onclick = async () => {
    // 先暂存表单里的 key（若填了），再测试
    const id = provPreset.value;
    const tmpKey = provKey.value.trim();
    if (tmpKey) {
      try {
        await apiFetch('/api/providers/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, models: provModel.value.split(',').map(s => s.trim()).filter(Boolean), baseUrl: provBase.value.trim(), apiKey: tmpKey }) });
      } catch (e) { alert('暂存失败: ' + e.message); return; }
      await loadProviderSettings(); await loadModels();
    }
    try {
      const r = await apiFetch('/api/provider/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const d = await r.json();
      alert(d.ok ? `✅ 可达，延迟 ${d.latencyMs}ms` + (d.error ? '（' + d.error + '）' : '') : `❌ ${d.error || '不可达'}`);
      await loadProviderSettings();
    } catch (e) { alert('测试失败: ' + e.message); }
  };

  /* ---------- 模型下拉（本地 + 云端分组） ---------- */
  async function loadModels() {
    try {
      const r = await apiFetch('/api/models'); const data = await r.json();
      const prev = modelSelect.value;
      modelSelect.innerHTML = '';
      const og1 = document.createElement('optgroup'); og1.label = '本地（离线）';
      for (const m of (data.local || [])) {
        const opt = document.createElement('option'); opt.value = m.value; opt.textContent = m.label;
        og1.appendChild(opt);
      }
      modelSelect.appendChild(og1);
      if ((data.cloud || []).length) {
        const og2 = document.createElement('optgroup'); og2.label = '云端 API';
        for (const m of data.cloud) {
          const opt = document.createElement('option'); opt.value = m.value; opt.textContent = m.label;
          og2.appendChild(opt);
        }
        modelSelect.appendChild(og2);
      }
      // 恢复之前选择（若还存在）
      if (prev && [...modelSelect.options].some(o => o.value === prev)) modelSelect.value = prev;
      else if (data.default) modelSelect.value = data.default;
      // 切换模型时预热本地模型
      modelSelect.onchange = () => {
        const v = modelSelect.value;
        if (!v.startsWith('cloud:')) apiFetch('/api/prewarm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: v }) }).catch(err => softFail('预热模型', err));
      };
    } catch (e) {
      // 关键路径：静默会让模型下拉变空且毫无解释（看起来像「模型全被删了」）。
      // 不覆盖已有选项，只在真的空着时补一条说明项。
      console.warn('[hermes] 模型列表加载失败:', e);
      if (!modelSelect.options.length) {
        const o = document.createElement('option');
        o.value = ''; o.disabled = true; o.selected = true;
        o.textContent = '模型列表加载失败：' + (e.message || e) + '（服务未启动或令牌失效）';
        modelSelect.appendChild(o);
      }
    }
  }

  // 历史消息回显：把某会话的全部消息渲染到主区（用户气泡 + 工具卡 + 回答）
  function renderHistory(msgs) {
    const runs = [];
    let run = null;
    const ensureRun = () => { if (!run) { run = createRunPanel(); runs.push(run); } return run; };
    for (const m of msgs) {
      if (m.role === 'user') { run = null; if (m.content) addUserMsg(m.content); continue; }
      if (m.role === 'assistant') {
        if (m.toolCalls) { ensureRun(); renderToolIntents(run, m.toolCalls); }
        if (m.content && m.content.trim()) { ensureRun(); setAnswer(run, m.content); hideThinking(run); run = null; }
        continue;
      }
      if (m.role === 'tool') { ensureRun(); fillToolResult(run, extractToolOutput(m.content)); hideThinking(run); }
    }
    for (const r of runs) {
      hideThinking(r);
      // 历史回放不该出现「实时进度」：createRunPanel 起的表要停掉，面板本身也移除，
      // 否则载入旧会话会看到一个永远不动（或一直跳秒）的进度条。
      trajFinish(r);
      const tr = r.querySelector('.traj'); if (tr) tr.remove();
      for (const card of r.querySelectorAll('.tool-card.pending')) card.remove();
      appendBotActs(r);
    }
    scrollDown();
  }

  // B2: 会话按日期分组（session id 前缀即时间戳 20260906_020114_xxxxxx）
  function sessGroupLabel(s) {
    const m = String(s.id || '').match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
    if (!m) return '更早';
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((today - d) / 86400000);
    if (diff <= 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff < 7) return '近 7 天';
    return '更早';
  }
  const GROUP_ORDER = ['今天', '昨天', '近 7 天', '更早'];

  function renderSessItem(s) {
    const el = document.createElement('div');
    el.className = 'sess-item' + (s.id === sessionId ? ' active' : '');
    const wsTag = wsAssign[s.id] ? '<span class="ws-tag">📁 ' + escapeHtml(wsAssign[s.id]) + '</span> ' : '';
    el.innerHTML = '<div class="t">' + escapeHtml(s.title) + '</div><div class="m">' + wsTag + escapeHtml(s.info) + '</div>'
      + '<div class="sess-actions">'
      + '<button type="button" data-act="move" title="移动到工作区"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l1.8 2.2h7A1.5 1.5 0 0 1 19 9.7v8.3a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 18z"/></svg></button>'
      + '<button type="button" data-act="rename" title="重命名"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18.2 3.3a2.1 2.1 0 0 1 3 3L13 14.5l-4 1 1-4z"/><path d="M19.5 14.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h4.5"/></svg></button>'
      + '<button type="button" data-act="export" title="导出 Markdown"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v11"/><polyline points="7.5,10 12,14.5 16.5,10"/><path d="M4 16.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.5"/></svg></button>'
      + '<button type="button" data-act="del" class="del" title="删除会话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16"/><path d="M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5"/><path d="M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/><line x1="10" y1="10.5" x2="10" y2="16.5"/><line x1="14" y1="10.5" x2="14" y2="16.5"/></svg></button></div>';
    el.querySelector('[data-act="move"]').onclick = (e) => { e.stopPropagation(); openWsPicker(el, s.id); };
    el.querySelector('[data-act="rename"]').onclick = (e) => { e.stopPropagation(); renameSession(s.id, s.title); };
    el.querySelector('[data-act="export"]').onclick = (e) => { e.stopPropagation(); exportSession(s.id); };
    el.querySelector('[data-act="del"]').onclick = (e) => { e.stopPropagation(); deleteSession(s.id); };
    el.onclick = async () => {
      sessionId = s.id; currentRunId = null; currentRunEl = null;
      setConvTitle(s.title, true);   // 会话视图顶栏：载入历史会话时显示其标题
      setConvMeta(wsAssign[s.id] || '');
      mountComposer(false);          // 输入卡先归位底部，再清空消息区（防被 innerHTML='' 连带销毁）
      if (isMobile()) setSideDrawer(false);   // 手机上选中会话后收起抽屉
      messagesEl.innerHTML = '';
      const note = document.createElement('div'); note.className = 'sysnote';
      note.textContent = '加载历史会话 ' + s.id + ' …';
      messagesEl.appendChild(note);
      try {
        const resp = await apiFetch('/api/history?session=' + encodeURIComponent(s.id));
        const data = await resp.json();
        messagesEl.innerHTML = '';
        if (data.messages && data.messages.length) renderHistory(data.messages);
        else { const e = document.createElement('div'); e.className = 'sysnote'; e.textContent = '该会话暂无消息记录'; messagesEl.appendChild(e); }
      } catch (err) {
        messagesEl.innerHTML = '';
        const e = document.createElement('div'); e.className = 'sysnote';
        e.textContent = '加载历史失败: ' + err.message; messagesEl.appendChild(e);
      }
      const tip = document.createElement('div'); tip.className = 'sysnote';
      tip.textContent = '已载入历史会话 ' + s.id + '，继续对话将延续该上下文。';
      messagesEl.appendChild(tip);
      updateHint(); loadSessions();
    };
    return el;
  }

  /* ---------- dsh 式工作区：侧栏 chips + 归属过滤 ---------- */
  async function loadWorkspaces() {
    try {
      const r = await apiFetch('/api/workspaces');
      if (!r.ok) return softFail('拉取工作区', new Error('HTTP ' + r.status));
      const data = await r.json();
      wsList = data.workspaces || [];
      wsAssign = data.assignments || {};
      renderWsBar();
    } catch (e) { softFail('拉取工作区', e); }
  }
  /* 新建工作区（侧栏 ＋ 与会话移动共用）。成功后刷新列表并按需把某会话归进去。 */
  async function createWorkspace(name, assignToId) {
    const n = String(name || '').trim().slice(0, 40);
    if (!n) return false;
    try {
      const r = await apiFetch('/api/workspace/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { alert('创建失败: ' + (d.error || r.status)); return false; }
      await loadWorkspaces();
      if (assignToId) await assignWorkspace(assignToId, n);
      return true;
    } catch (e) { alert('创建失败: ' + e.message); return false; }
  }

  /* 会话归属变更。workspace 传空串 = 移出工作区（归入「未归类」）。 */
  async function assignWorkspace(sid, name) {
    try {
      const r = await apiFetch('/api/workspace/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid, workspace: name || '' }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { alert('移动失败: ' + (d.error || r.status)); return; }
      await loadWorkspaces();
      loadSessions();
      if (sid === sessionId) setConvMeta(name || '');   // 顶栏归属徽标同步
    } catch (e) { alert('移动失败: ' + e.message); }
  }

  /* 会话项上的轻量归属选择器：点 📁 就地展开一个 select，选中即写接口、选完自收。
   * 不用 prompt 手打名字——已有工作区必须能一键选，手打必然拼出不一致的同名鲁鱼。 */
  /* 移除节点前必须确认它还在 DOM 里：blur 与其它路径可能已经把它摘掉，
   * 二次 remove 会抛 NotFoundError（即便 try 吃掉，也不该靠异常做控制流）。 */
  function dropNode(n) { try { if (n && n.parentNode) n.remove(); } catch { /* 已移除 */ } }

  function openWsPicker(anchorEl, sid) {
    const existing = anchorEl.querySelector('.ws-picker');
    if (existing) { dropNode(existing); return; }         // 再点一次收起
    const cur = wsAssign[sid] || '';
    const sel = document.createElement('select');
    sel.className = 'ws-picker';
    const mkOpt = (v, label) => { const o = document.createElement('option'); o.value = v; o.textContent = label; if (v === cur) o.selected = true; sel.appendChild(o); };
    mkOpt('', '未归类');
    for (const w of wsList) mkOpt(w, '📁 ' + w);
    mkOpt('__new__', '＋ 新建工作区…');
    let busy = false;
    const commit = async () => {
      if (busy) return; busy = true;
      const v = sel.value;
      dropNode(sel);
      try {
        if (v === '__new__') {
          const n = prompt('新工作区名称（1-40 字）：', '');
          if (n && n.trim()) await createWorkspace(n, sid);
          return;
        }
        if (v !== cur) await assignWorkspace(sid, v);
      } finally { busy = false; }
    };
    sel.onchange = commit;
    sel.onblur = () => dropNode(sel);
    sel.onclick = (e) => e.stopPropagation();           // 别让点击冒泡成"打开会话"
    anchorEl.appendChild(sel);
    sel.focus();
  }

  /* 工作区右键菜单：重命名 / 删除。
   * 删除前必须报清挂载数量——默认区之外的删除会连带清掉该区全部会话归属，
   * 一次点错就是一批会话散落回「未归类」且不可撤销（无回收站）。 */
  function wsContextMenu(name, anchorEl) {
    const owned = Object.keys(wsAssign).filter(k => wsAssign[k] === name);
    const tip = owned.length ? `（含 ${owned.length} 个会话，删除后它们将回到「未归类」）` : '（无会话）';
    const menu = document.createElement('div');
    menu.className = 'ws-menu';
    const item = (text, danger, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ws-menu-item' + (danger ? ' danger' : ''); b.textContent = text;
      b.onclick = (e) => { e.stopPropagation(); menu.remove(); fn(); };
      menu.appendChild(b);
    };
    item('重命名…', false, async () => {
      const to = prompt(`重命名工作区「${name}」（保留 ${owned.length} 个会话归属）：`, name);
      if (to == null) return;
      try {
        const r = await apiFetch('/api/workspace/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: name, to: to.trim().slice(0, 40) }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { alert('重命名失败: ' + (d.error || r.status)); return; }
        await loadWorkspaces();                       // 归属整体迁移，必须用服务端返回值重建本地映射
        if (activeWs === name) activeWs = (to.trim().slice(0, 40)) || '';
        renderWsBar(); loadSessions(); refreshHeroCtx();
      } catch (e) { alert('重命名失败: ' + e.message); }
    });
    const locked = name === '默认';
    item(locked ? '默认工作区不可删除' : '删除工作区…', !locked, async () => {
      if (locked) { alert('默认工作区不可删除（它是存储缺失时的回落锚点）。'); return; }
      if (!confirm(`删除工作区「${name}」？\n${tip}\n此操作不可恢复。`)) return;
      try {
        const r = await apiFetch('/api/workspace/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { alert('删除失败: ' + (d.error || r.status)); return; }
        if (activeWs === name) activeWs = '';
        await loadWorkspaces(); renderWsBar(); loadSessions(); refreshHeroCtx();
      } catch (e) { alert('删除失败: ' + e.message); }
    });
    const close = (e) => {
      if (!menu.contains(e.target) && e.target !== anchorEl) { dropNode(menu); document.removeEventListener('pointerdown', close); }
    };
    document.addEventListener('pointerdown', close);
    anchorEl.parentNode.appendChild(menu);
  }

  function renderWsBar() {
    const bar = $('wsBar');
    if (!bar) return;
    bar.innerHTML = '';
    const mk = (label, val, cls) => {
      const c = document.createElement('button');
      c.type = 'button'; c.className = 'ws-chip' + (cls ? ' ' + cls : '') + (activeWs === val ? ' on' : '');
      c.textContent = label;
      // 右键（或长按）才出改名/删除：放在左键会让"切换工作区"这种高频操作变得危险。
      if (cls !== 'add' && val) {
        c.title = '右键：重命名 / 删除';
        c.oncontextmenu = (e) => { e.preventDefault(); wsContextMenu(val, c); };
      }
      c.onclick = async () => {
        if (cls === 'add') {
          const name = prompt('新工作区名称（1-40 字）：', '');
          if (!name || !name.trim()) return;
          // 复用 createWorkspace：侧栏与「移动到工作区」必须走同一条创建路径，否则两处行为会漂移
          const okNew = await createWorkspace(name.trim());
          if (okNew) activeWs = name.trim().slice(0, 40);
        } else {
          activeWs = (activeWs === val) ? '' : val;   // 再点一次取消（回「全部」）
        }
        renderWsBar(); loadSessions(); refreshHeroCtx();
      };
      bar.appendChild(c);
    };
    mk('全部', '', 'all');
    for (const w of wsList) mk(w, w);
    mk('＋', '', 'add');
  }
  /* Hero 空态的工作区选择 chip（在标题下方，dsh 同位）；进入会话后不存在，由 conv-meta 承担 */
  function refreshHeroCtx() {
    const sel = document.getElementById('heroWs');
    if (!sel) return;
    sel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = ''; optAll.textContent = '未归类';
    sel.appendChild(optAll);
    for (const w of wsList) {
      const o = document.createElement('option'); o.value = w; o.textContent = '📁 ' + w; sel.appendChild(o);
    }
    sel.value = activeWs || '';
  }

  async function loadSessions() {
    // 失败必须显式暴露：以前是 catch(e){} 静默吞掉，服务挂了 / 401 / 接口报错
    // 都只显示"暂无历史会话"，用户分不清是"真没有"还是"没加载出来"。
    try {
      const r = await apiFetch('/api/sessions');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const q = ($('sessSearch').value || '').trim().toLowerCase();
      sessListEl.innerHTML = '';
      // P1-4: 「解析降级」不能静默 —— CLI 输出格式变更时后端会给 degraded 标记。
      // 列表照常渲染（不阻断），但顶部给一条可点击重试的告警，避免被当成"本来就没有会话"。
      if (data.degraded) {
        const w = document.createElement('div');
        w.className = 'sess-group';
        w.textContent = '⚠ ' + (data.warning || '会话列表解析异常（疑似 CLI 输出格式变更）') + ' · 点击重试';
        w.style.cursor = 'pointer';
        w.style.color = 'var(--danger, #c0392b)';
        w.title = '点击重新加载会话列表';
        w.onclick = loadSessions;
        sessListEl.appendChild(w);
      }
      const list = (data.sessions || []).filter(s =>
        (!activeWs || wsAssign[s.id] === activeWs) &&
        (!q || String(s.title).toLowerCase().includes(q) || String(s.info).toLowerCase().includes(q) || String(s.id).includes(q))
      );
      // 工作区过滤下补充分组标签，让「这个工作区有什么」一目了然
      const scopeLabel = activeWs ? activeWs + ' · ' : '';
      const groups = {};
      list.forEach(s => { const g = sessGroupLabel(s); (groups[g] = groups[g] || []).push(s); });
      for (const label of GROUP_ORDER) {
        if (!groups[label] || !groups[label].length) continue;
        const h = document.createElement('div'); h.className = 'sess-group'; h.textContent = scopeLabel + label + ' · ' + groups[label].length;
        sessListEl.appendChild(h);
        for (const s of groups[label]) sessListEl.appendChild(renderSessItem(s));
      }
      if (!list.length) {
        const e = document.createElement('div'); e.className = 'sess-group';
        e.textContent = q ? '无匹配会话' : (activeWs ? '该工作区暂无会话' : '暂无历史会话'); sessListEl.appendChild(e);
      }
    } catch (e) {
      sessListEl.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'sess-group';
      box.textContent = '会话列表加载失败' + (e && e.message ? '（' + e.message + '）' : '') + ' · 点击重试';
      box.style.cursor = 'pointer';
      box.style.color = 'var(--danger, #c0392b)';
      box.title = '点击重新加载会话列表';
      box.onclick = loadSessions;
      sessListEl.appendChild(box);
    }
  }

  /* ---------- L4: 会话管理 ---------- */
  async function renameSession(id, oldTitle) {
    const t = prompt('重命名会话：', oldTitle || '');
    if (t == null || !t.trim()) return;
    try {
      const r = await apiFetch('/api/session/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, title: t.trim().slice(0, 80) }) });
      if (r.ok) loadSessions(); else { const d = await r.json().catch(() => ({})); alert('重命名失败: ' + (d.error || r.status)); }
    } catch (e) { alert('重命名失败: ' + e.message); }
  }
  async function deleteSession(id) {
    if (!confirm('确定删除该会话？此操作不可恢复。')) return;
    try {
      const r = await apiFetch('/api/session/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      if (r.ok) { if (id === sessionId) newChat(); loadSessions(); }
      else { const d = await r.json().catch(() => ({})); alert('删除失败: ' + (d.error || r.status)); }
    } catch (e) { alert('删除失败: ' + e.message); }
  }
  async function exportSession(id) {
    try {
      const r = await apiFetch('/api/session/export?session=' + encodeURIComponent(id));
      if (!r.ok) { alert('导出失败'); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'hermes-' + id + '.md';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { alert('导出失败: ' + e.message); }
  }

  /* ---------- L4: 侧栏状态底栏（Ollama 驻留 + 近轮用量） ---------- */
  async function refreshStatus() {
    try {
      const [s, u] = await Promise.all([
        apiFetch('/api/status').then(r => r.json()).catch(() => null),
        apiFetch('/api/usage').then(r => r.json()).catch(() => null)
      ]);
      // 浏览器缓存适配：服务端页面 mtime 与本页面版本戳不一致 → 弹刷新提示条
      try {
        const h = await apiFetch('/api/health').then(r => r.json()).catch(() => null);
        const stale = !!(h && h.uiVersion && window.__UI_VERSION__ && window.__UI_VERSION__ !== '__UI_VERSION__' && h.uiVersion !== window.__UI_VERSION__);
        const banner = document.getElementById('verBanner');
        if (banner) banner.classList.toggle('show', stale);
      } catch (e) { softFail('界面更新提示', e); }   // 提示条拿不到不影响功能
      const dot = $('ollamaDot'), txt = $('ollamaTxt');
      if (s && s.ollama && s.ollama.up) {
        const m = (s.ollama.models || [])[0];
        dot.className = 'dot ok';
        txt.textContent = m
          ? ('Ollama · ' + m.name.replace(':latest', '') + ' ' + m.sizeGb + 'GB 已驻留')
          : ('Ollama 运行中 · 无驻留' + (s.ollama.available ? ' · 可用 ' + s.ollama.available + ' 个模型' : ''));
      } else {
        dot.className = 'dot bad';
        txt.textContent = 'Ollama 未运行';
      }
      if (u) {
        const rowsHtml = (u.runs || []).slice(0, 5).map(r => {
          const icon = r.cloud ? '<span class="cloud">☁</span>' : '🏠';
          const tps = r.tokPerSec ? '<span class="tps"> ' + r.tokPerSec + 't/s</span>' : '';
          const time = new Date(r.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          return '<div class="usage-row" title="' + escapeHtml(r.prompt || '') + '">' + icon + ' ' + time + ' · ' + r.elapsedSec + 's' + tps + (r.toolCalls ? ' · 🔧' + r.toolCalls : '') + '</div>';
        }).join('');
        // P3-12：统计来自落盘 JSONL（~/.hermes/usage.jsonl），跨重启累计 —— 只看近 24h 均值，
        // 避免不同模型/版本的旧数据混进来掩盖真实变化。无数据时不占位。
        const s = u.summary || {};
        const sumHtml = s.last24h
          ? '<div class="usage-row" title="来自落盘统计 ~/.hermes/usage.jsonl（跨重启累计）">Σ 24h ' + s.last24h + ' 轮'
            + (s.avgFirstTokenSec24h != null ? ' · 首字均 ' + s.avgFirstTokenSec24h + 's' : '')
            + (s.avgTokPerSec24h != null ? ' · ~' + s.avgTokPerSec24h + 't/s' : '')
            + (s.toolCallsTotal ? ' · 🔧' + s.toolCallsTotal : '') + '</div>'
          : '';
        $('usageList').innerHTML = rowsHtml + sumHtml;
      }
    } catch (e) { softFail('侧栏状态刷新', e); }   // 15s 周期的可选增强；失败留痕但不停轮询（服务恢复后自愈）
  }
  setInterval(refreshStatus, 15000);

  /* ---------- L4: 代码块复制按钮（事件委托，clipboard API + execCommand 双兜底） ---------- */
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); ta.remove();
        return ok;
      } catch { return false; }
    }
  }
  messagesEl.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('.copy-code-btn');
    if (!btn) return;
    const code = btn.parentElement.querySelector('code');
    if (!code) return;
    const ok = await copyText(code.innerText);
    btn.textContent = ok ? '已复制' : '复制失败';
    btn.classList.toggle('ok', ok);
    setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('ok'); }, 1500);
  });

  /* ---------- L5: 消息操作（编辑重发 / 复制 / 重新生成 / 朗读） ---------- */
  function stripMarkdownForTts(md) {
    return String(md)
      .replace(/```[\s\S]*?```/g, '，代码省略，')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#*_~>|]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function speakText(text) {
    if (!('speechSynthesis' in window)) { alert('当前浏览器不支持语音合成'); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(stripMarkdownForTts(text).slice(0, 3000));
    u.lang = 'zh-CN'; u.rate = 1.05;
    speechSynthesis.speak(u);
  }
  messagesEl.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('.msg-acts button');
    if (!b) return;
    const act = b.dataset.act;
    const userMsg = b.closest('.msg.user');
    if (act === 'edit' && userMsg) {
      inputEl.value = userMsg.dataset.raw || '';
      inputEl.focus();
      inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
    } else if (act === 'copy' && userMsg) {
      const ok = await copyText(userMsg.dataset.raw || '');
      b.textContent = ok ? '已复制' : '失败';
      setTimeout(() => { b.textContent = '复制'; }, 1200);
    } else if (act === 'regen') {
      if (busy) { alert('当前有任务运行中，请先等待完成或取消'); return; }
      if (!lastPrompt) { alert('没有可重新生成的指令'); return; }
      send(lastPrompt);
    } else if (act === 'speak') {
      const run = b.closest('.run');
      const ans = run && run.querySelector('.answer');
      if (ans && ans.textContent.trim()) speakText(ans.textContent);
    }
  });

  /* ---------- L5→本地化: 语音输入（gemma4 原生音频，音频不出本机） ----------
   * 旧实现走 Web Speech API —— Chrome 会把音频传 Google 服务器识别，与 local-first 红线冲突。
   * 现改为：MediaRecorder 录音 → 解码重采样成 16kHz 单声道 WAV → POST /api/transcribe
   * → gemma4:e4b 原生音频转写 → 文本填入输入框。全程不离开本机。
   */
  const micBtn = $('micBtn');
  let mediaRec = null, micChunks = [], micTimer = null, micBusy = false;

  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(bin);
  }
  // 单声道 Float32 → 16-bit PCM WAV（Ollama 的音频输入用 WAV 最稳）
  function float32ToWav(samples, sampleRate) {
    const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
    const wr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    wr(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); wr(8, 'WAVE');
    wr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    wr(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0, o = 44; i < samples.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Uint8Array(buf);
  }
  async function transcribeBlob(blob) {
    const ab = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const decoded = await ac.decodeAudioData(ab.slice(0));   // Safari 会 detach，传副本
    const dstRate = 16000;
    const frames = Math.max(1, Math.ceil(decoded.length / dstRate) * dstRate);
    const off = new OfflineAudioContext(1, frames, dstRate);
    const src = off.createBufferSource();
    src.buffer = decoded; src.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    try { ac.close(); } catch (e) { softFail('关闭音频上下文', e); }   // 已被浏览器回收时 close 会抛，无害
    const wav = float32ToWav(rendered.getChannelData(0), dstRate);
    if (wav.length > 16 * 1024 * 1024) throw new Error('录音过长，请控制在 3 分钟内');
    const r = await apiFetch('/api/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: bytesToB64(wav) })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    return String(d.text || '').trim();
  }
  function micSetState(state) {   // idle | rec | busy
    micBtn.classList.toggle('on', state === 'rec');
    micBtn.style.opacity = state === 'busy' ? '0.5' : '';
    micBtn.title = state === 'rec' ? '正在录音…点击停止'
      : state === 'busy' ? '本地转写中（gemma4 音频）…'
      : '语音输入（本地转写，音频不出本机）';
  }
  micBtn.onclick = async () => {
    if (micBusy) return;
    if (mediaRec) { try { mediaRec.stop(); } catch (e) { softFail('停止录音', e); } return; }   // 再点一次停止
    if (!navigator.mediaDevices || !window.MediaRecorder) { alert('当前浏览器不支持录音，请使用 Chrome / Edge / Safari'); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { alert('无法访问麦克风：' + e.message); return; }
    micChunks = [];
    mediaRec = new MediaRecorder(stream);
    mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) micChunks.push(e.data); };
    mediaRec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearTimeout(micTimer);
      const mime = (mediaRec && mediaRec.mimeType) || 'audio/webm';
      const blob = new Blob(micChunks, { type: mime });
      mediaRec = null; micChunks = [];
      if (!blob.size) { micSetState('idle'); return; }
      micBusy = true; micSetState('busy');
      const base = inputEl.value ? inputEl.value.replace(/\s+$/, '') + ' ' : '';
      addNote('🎙️ 正在本地转写（gemma4 音频，不走云端）…');
      try {
        const text = await transcribeBlob(blob);
        if (text) {
          inputEl.value = base + text;
          inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
          inputEl.focus();
        } else {
          addNote('未识别到语音内容，请靠近麦克风重试。');
        }
      } catch (e) { alert('转写失败：' + (e.message || e)); }
      micBusy = false; micSetState('idle');
    };
    mediaRec.start();
    micSetState('rec');
    micTimer = setTimeout(() => { if (mediaRec) { try { mediaRec.stop(); } catch (e) { softFail('录音超时停止', e); } } }, 180000);   // 上限 3 分钟
  };

  /* ---------- L5: 工具箱（MCP / 定时任务 / 技能 / 记忆） ---------- */
  const toolsMask = $('toolsMask'), tabBar = $('tabBar'), tabBody = $('tabBody');
  let curTab = 'mcp';
  $('toolsBtn').onclick = () => { toolsMask.classList.add('show'); loadTab(curTab); };
  $('toolsClose').onclick = () => toolsMask.classList.remove('show');
  tabBar.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.tab');
    if (!b) return;
    curTab = b.dataset.tab;
    [...tabBar.children].forEach(x => x.classList.toggle('active', x === b));
    loadTab(curTab);
  });
  async function loadTab(tab) {
    tabBody.innerHTML = '<p>加载中…</p>';
    try {
      if (tab === 'mcp') await renderMcp();
      else if (tab === 'cron') await renderCron();
      else if (tab === 'skills') await renderSkills();
      else await renderMemory();
    } catch (e) { tabBody.innerHTML = '<p>加载失败: ' + escapeHtml(e.message) + '</p>'; }
  }

  async function renderMcp() {
    const r = await apiFetch('/api/mcp'); const d = await r.json();
    tabBody.innerHTML = (d.degraded ? '<p style="color:var(--danger, #c0392b);">⚠ ' + escapeHtml(d.warning || 'MCP 列表解析异常（疑似 CLI 输出格式变更）') + '</p>' : '')
      + '<p>通过 MCP（Model Context Protocol）为 Agent 扩展外部工具。若添加/连接失败，请先在终端运行 <code>hermes setup</code> 安装 MCP 支持。</p>'
      + '<div class="toolbox-list" id="mcpList"></div>'
      + '<div class="lbl">添加服务（URL 端点，或 命令 + 参数）</div>'
      + '<div class="field-row">'
      + '<input id="mcpName" placeholder="名称，如 filesystem" />'
      + '<input id="mcpUrl" class="token-ish" placeholder="https://… 或 /path/to/command" />'
      + '<input id="mcpArgs" class="token-ish" placeholder="命令参数（可选）" />'
      + '</div>'
      + '<div class="actions"><button class="primary" id="mcpAdd">添加</button><button id="mcpRefresh">刷新</button></div>';
    const listEl = $('mcpList');
    if (!(d.servers || []).length) listEl.innerHTML = '<p>暂无 MCP 服务。</p>';
    for (const s of d.servers || []) {
      const el = document.createElement('div'); el.className = 'tb-item';
      el.innerHTML = '<span class="nm">' + escapeHtml(s.name) + '</span>'
        + '<span class="sub">' + escapeHtml(s.detail || '') + '</span>'
        + '<button type="button">移除</button>';
      el.querySelector('button').onclick = async () => {
        if (!confirm('移除 MCP 服务 ' + s.name + '？')) return;
        const rr = await apiFetch('/api/mcp/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.name }) });
        const dd = await rr.json();
        if (!dd.ok) alert(dd.error || dd.message || '移除失败');
        loadTab('mcp');
      };
      listEl.appendChild(el);
    }
    $('mcpRefresh').onclick = () => loadTab('mcp');
    $('mcpAdd').onclick = async () => {
      const name = $('mcpName').value.trim(), url = $('mcpUrl').value.trim(), args = $('mcpArgs').value.trim();
      if (!name || !url) { alert('名称与 URL/命令必填'); return; }
      const body = { name };
      if (/^https?:\/\//i.test(url)) body.url = url; else { body.command = url; if (args) body.args = args; }
      const rr = await apiFetch('/api/mcp/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const dd = await rr.json();
      alert((dd.ok ? '✅ ' : '❌ ') + (dd.message || dd.error || ''));
      loadTab('mcp');
    };
  }

  async function renderCron() {
    const r = await apiFetch('/api/cron'); const d = await r.json();
    tabBody.innerHTML = '<p id="cronGw"></p>'
      + (d.degraded ? '<p style="color:var(--danger, #c0392b);">⚠ ' + escapeHtml(d.warning || '定时任务列表解析异常（疑似 CLI 输出格式变更）') + '</p>' : '')
      + '<div class="toolbox-list" id="cronList"></div>'
      + '<div class="lbl">新建任务</div>'
      + '<div class="field-row">'
      + '<input id="cronName" placeholder="任务名（可选）" />'
      + '<input id="cronSched" class="token-ish" placeholder="计划：30m / every 2h / 0 9 * * *" />'
      + '</div>'
      + '<input id="cronPrompt" placeholder="任务指令（自包含提示词，如：总结今天的日志）" />'
      + '<div class="actions"><button class="primary" id="cronCreate">创建</button><button id="cronRefresh">刷新</button></div>';
    $('cronGw').innerHTML = d.gatewayOk
      ? '<span style="color:var(--green);">✅ 网关运行中，任务会按时自动触发。</span>'
      : '<span style="color:var(--cloud);">⚠️ 网关未运行，任务不会自动触发。终端运行 <code>hermes gateway install</code> 后生效。</span>';
    const listEl = $('cronList');
    if (!(d.jobs || []).length) listEl.innerHTML = '<p>暂无定时任务。</p>';
    for (const j of d.jobs || []) {
      const el = document.createElement('div'); el.className = 'tb-item';
      const on = j.state === 'active';
      el.innerHTML = '<span class="badge' + (on ? ' on' : '') + '">' + escapeHtml(on ? '运行中' : (j.state || '')) + '</span>'
        + '<span class="nm" title="' + escapeHtml(j.id) + '">' + escapeHtml(j.name || j.id) + '</span>'
        + '<span class="sub">' + escapeHtml(j.schedule) + (j.nextRun ? ' · 下次 ' + escapeHtml(j.nextRun) : '') + '</span>'
        + '<button type="button" data-a="run">立即跑</button>'
        + (on ? '<button type="button" data-a="pause">暂停</button>' : '<button type="button" data-a="resume">恢复</button>')
        + '<button type="button" data-a="remove">删除</button>';
      el.querySelectorAll('button').forEach(btn => {
        btn.onclick = async () => {
          const a = btn.dataset.a;
          if (a === 'remove' && !confirm('删除任务 ' + (j.name || j.id) + '？')) return;
          const rr = await apiFetch('/api/cron/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: j.id, action: a }) });
          const dd = await rr.json();
          if (!dd.ok) alert(dd.error || dd.message || '操作失败');
          loadTab('cron');
        };
      });
      listEl.appendChild(el);
    }
    $('cronRefresh').onclick = () => loadTab('cron');
    $('cronCreate').onclick = async () => {
      const body = { schedule: $('cronSched').value.trim(), prompt: $('cronPrompt').value.trim(), name: $('cronName').value.trim() };
      if (!body.schedule || !body.prompt) { alert('计划与指令必填'); return; }
      const rr = await apiFetch('/api/cron/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const dd = await rr.json();
      alert((dd.ok ? '✅ 已创建\n' : '❌ ') + (dd.message || dd.error || ''));
      loadTab('cron');
    };
  }

  async function renderSkills() {
    tabBody.innerHTML = '<p>加载已安装技能…</p>';
    const r = await apiFetch('/api/skills'); const d = await r.json();
    tabBody.innerHTML = '<div class="field-row">'
      + '<input id="skillQuery" placeholder="用一句话找技能，如「帮我看图」「写个爬虫」" />'
      + '<button id="skillSearch" style="flex:0 0 auto;">语义搜索</button></div>'
      + '<div class="tb-raw" id="skillSearchOut" style="display:none;"></div>'
      + '<div class="lbl">已安装（' + (d.skills || []).length + '）</div>'
      + '<div class="toolbox-list" id="skillList"></div>'
      + '<div class="actions"><button id="skillRefresh">刷新</button></div>';
    const listEl = $('skillList');
    if (!(d.skills || []).length) listEl.innerHTML = '<p>暂无已安装技能。</p>';
    for (const s of d.skills || []) {
      const el = document.createElement('div'); el.className = 'tb-item';
      const on = s.status === 'enabled';
      el.innerHTML = '<span class="badge' + (on ? ' on' : '') + '">' + escapeHtml(s.status || '') + '</span>'
        + '<span class="nm">' + escapeHtml(s.name) + '</span>'
        + '<span class="sub">' + escapeHtml(s.description || s.source || '') + '</span>'
        + '<button type="button" class="use" title="把调用脚手架注入输入框">➡️ 使用</button>'
        + '<button type="button" class="rm" title="卸载技能">卸载</button>';
      // C2: 点击"使用"→ 注入点名脚手架的提示语到聊天输入框，用户补任务即可发送
      el.querySelector('.use').onclick = async () => {
        toolsMask.classList.remove('show');
        const base = '请加载并使用技能 [' + s.name + ']' + (s.description ? '（' + s.description + '）' : '') + '，按该技能的方法论来处理下面的任务：\n';
        inputEl.value = base;
        inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
        inputEl.focus(); inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        addNote('已将技能 ' + s.name + ' 的调用脚手架填入输入框，补充任务后发送即可。');
      };
      el.querySelector('.rm').onclick = async () => {
        if (!confirm('卸载技能 ' + s.name + '？')) return;
        const rr = await apiFetch('/api/skills/uninstall', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.name }) });
        const dd = await rr.json();
        if (!dd.ok) alert(dd.error || dd.message || '卸载失败');
        loadTab('skills');
      };
      listEl.appendChild(el);
    }
    $('skillRefresh').onclick = () => loadTab('skills');
    // 本地语义检索：bge-m3 嵌入 → 按相关度返回技能（自然语言找技能）
    $('skillSearch').onclick = async () => {
      const q = $('skillQuery').value.trim();
      const out = $('skillSearchOut');
      out.style.display = 'block';
      if (!q) { out.textContent = '输入一句话描述你要做的事，例如「帮我看图」「写个爬虫」。'; return; }
      out.textContent = '语义检索中（bge-m3 本地嵌入）…';
      try {
        const rr = await apiFetch('/api/skills/find', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, top: 8 }) });
        const dd = await rr.json();
        const ms = dd.matches || [];
        if (!ms.length) {
          out.textContent = dd.fallback ? '语义检索不可用（bge-m3 未安装？）。' : '（没有匹配的技能）';
          return;
        }
        out.innerHTML = '<div class="lbl">按相关度排序（点「使用」注入脚手架）</div><div class="toolbox-list" id="skillMatchList"></div>';
        const ml = $('skillMatchList');
        for (const m of ms) {
          const el = document.createElement('div'); el.className = 'tb-item';
          el.innerHTML = '<span class="badge on">' + Math.round((m.score || 0) * 100) + '%</span>'
            + '<span class="nm">' + escapeHtml(m.name) + '</span>'
            + '<span class="sub">' + escapeHtml(m.description || '') + '</span>'
            + '<button type="button" class="use" title="把调用脚手架注入输入框">➡️ 使用</button>';
          el.querySelector('.use').onclick = () => {
            toolsMask.classList.remove('show');
            const base = '请加载并使用技能 [' + m.name + ']' + (m.description ? '（' + m.description + '）' : '') + '，按该技能的方法论来处理下面的任务：\n';
            inputEl.value = base;
            inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
            inputEl.focus(); inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
            addNote('已将技能 ' + m.name + ' 的调用脚手架填入输入框，补充任务后发送即可。');
          };
          ml.appendChild(el);
        }
      } catch (e) { out.textContent = '搜索失败: ' + e.message; }
    };
  }

  async function renderMemory() {
    const r = await apiFetch('/api/memory'); const d = await r.json();
    tabBody.innerHTML = '<p>Agent 的长期记忆（每次对话自动读取）。直接编辑，保存即生效。</p>'
      + '<div class="lbl">MEMORY.md（项目 / 任务记忆）</div>'
      + '<textarea class="mem-area" id="memEdit"></textarea>'
      + '<div class="lbl">USER.md（用户偏好）</div>'
      + '<textarea class="mem-area" id="userEdit" style="min-height:80px;"></textarea>'
      + '<div class="actions"><button class="primary" id="memSave">保存</button><button id="memReload">重载</button></div>';
    $('memEdit').value = d.memory || '';
    $('userEdit').value = d.user || '';
    $('memReload').onclick = () => renderMemory();
    $('memSave').onclick = async () => {
      try {
        const h = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
        const r1 = await apiFetch('/api/memory/save', { ...h, body: JSON.stringify({ which: 'memory', content: $('memEdit').value }) });
        const r2 = await apiFetch('/api/memory/save', { ...h, body: JSON.stringify({ which: 'user', content: $('userEdit').value }) });
        const d1 = await r1.json(), d2 = await r2.json();
        if (d1.error || d2.error) alert('保存失败: ' + (d1.error || d2.error));
        else alert('✅ 记忆已保存，下轮对话生效');
      } catch (e) { alert('保存失败: ' + e.message); }
    };
  }

  function handleFrame(frame) {
    let ev = 'message', data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    let obj; try { obj = JSON.parse(data); } catch { return; }
    if (ev === 'ready') {
      currentRunId = obj.runId; if (obj.sessionId) sessionId = obj.sessionId;
      curStats = null;
      if (obj.cloud) addNote('☁️ 本轮使用云端模型 ' + obj.model, 'cloud');
      // F②：危险放行提示。gateway 路径带 bypassTtlMin（文件放行有 TTL）；-z 路径按轮 env 放行、仅本轮有效。
      if (obj.allowDangerous) {
        addNote(obj.bypassTtlMin
          ? '⚠️ 危险命令放行已开启：本会话 ' + obj.bypassTtlMin + ' 分钟内生效，到期自动恢复拦截'
          : '⚠️ 危险命令放行已开启（仅本轮有效）', 'cloud');
      }
      // T2 轨迹：连接已建立 → 进入「准备上下文」阶段（实测这段通常 <100ms）
      trajAdvance(currentRunEl, 'session');
      updateHint();
    }
    else if (ev === 'session') {
      sessionId = obj.sessionId;
      if (activeWs && !wsAssign[sessionId]) { wsAssign[sessionId] = activeWs; renderWsBar(); }   // 乐观更新，省一次拉取
      if (activeWs) setConvMeta(activeWs);
      // T2 轨迹：会话就绪 → 进入「模型推理」。这是真正的大头（system prompt prefill），
      // 也是用户原先唯一感知到的那段空白，必须让其可见。
      trajAdvance(currentRunEl, 'think');
      updateHint(); loadSessions();
    }
    else if (ev === 'notice') { addNote('☁️ ' + obj.message, 'cloud'); }
    else if (ev === 'token') {
      // 真流式：逐 token 追加到当前 run 的回答区（节流渲染）
      if (!currentRunEl) currentRunEl = createRunPanel();
      if (tokenIgnore) return;          // 最终回答已渲染，忽略迟到增量
      liveText += obj.text || '';
      hideThinking(currentRunEl);
      trajFinish(currentRunEl);          // T2 轨迹：首字已出，「模型推理」阶段完成并停表
      scheduleLiveRender();
    }
    else if (ev === 'msg') {
      if (obj.role === 'user') return;
      if (!currentRunEl) currentRunEl = createRunPanel();
      if (obj.role === 'tool') {
        fillToolResult(currentRunEl, extractToolOutput(obj.content));
        hideThinking(currentRunEl);
        tokenIgnore = false;            // 工具结果后可能有新的回答段
      }
      else if (obj.role === 'assistant') {
        if (obj.reasoning && String(obj.reasoning).trim()) appendReasoning(currentRunEl, obj.reasoning);   // C3 思考可视化
        if (obj.toolCalls) {
          renderToolIntents(currentRunEl, obj.toolCalls);
          if (obj.content && obj.content.trim()) { setAnswer(currentRunEl, obj.content); liveText = ''; }
          tokenIgnore = false;          // 后续还有回答段
        } else if (obj.content && obj.content.trim()) {
          // 权威最终回答：覆盖 token 流累积，停止接收迟到 token
          setAnswer(currentRunEl, obj.content);
          hideThinking(currentRunEl);
          liveText = ''; tokenIgnore = true;
        }
      }
    }
    else if (ev === 'done') {
      trajFinish(currentRunEl);          // T2 轨迹：收尾停表（幂等，可能已在首 token 处完成）
      sessionId = obj.sessionId; curStats = obj; setBusy(false); updateHint(); loadSessions(); refreshStatus();
      appendBotActs(currentRunEl);
      const ansEl = currentRunEl && currentRunEl.querySelector('.answer');
      const answerText = ansEl ? ansEl.textContent.trim() : '';
      notifyDone(obj.elapsed);           // B6: 长任务完成提醒
      currentRunId = null; currentRunEl = null; scrollDown();
      maybeSuggest(answerText);          // 豆包式"为你推荐"：后台生成追问磁贴
    }
    else if (ev === 'error') { trajFinish(currentRunEl, false); if (currentRunEl) setAnswer(currentRunEl, '出错: ' + escapeHtml(obj.message)); setBusy(false); currentRunId = null; currentRunEl = null; }
  }

  // C4: 图片上传（gemma4 识别闭环）
  const imgBtn = $('imgBtn'), imgInput = $('imgInput'), imgPreviewEl = $('imgPreview');
  let pendingImg = null;   // { dataUrl, b64, name }  待发送图片
  imgBtn.onclick = () => imgInput.click();
  imgInput.addEventListener('change', () => {
    const f = imgInput.files && imgInput.files[0];
    imgInput.value = '';
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        // 压缩到最长边 1280 的 JPEG，避免超大 base64
        const max = 1280;
        let w = img.width, h = img.height;
        const k = Math.min(1, max / Math.max(w, h));
        w = Math.round(w * k); h = Math.round(h * k);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = c.toDataURL('image/jpeg', 0.85);
        pendingImg = { dataUrl, b64: dataUrl.split(',')[1], name: f.name || 'pasted' };
        renderImgPreview();
      };
      img.onerror = () => { alert('无法读取该图片'); };
      img.src = fr.result;
    };
    fr.readAsDataURL(f);
  });
  function renderImgPreview() {
    if (!pendingImg) { imgPreviewEl.classList.remove('show'); imgPreviewEl.innerHTML = ''; return; }
    imgPreviewEl.classList.add('show');
    imgPreviewEl.innerHTML = '<div class="thumb"><img src="' + pendingImg.dataUrl + '" alt="预览" />'
      + '<button type="button" class="rm" title="移除图片">✕</button></div>'
      + '<span class="tag">' + escapeHtml(pendingImg.name) + ' · 发送时将先用 gemma4 识别图片内容</span>';
    imgPreviewEl.querySelector('.rm').onclick = () => { pendingImg = null; renderImgPreview(); };
  }
  // 经 gemma4 识别图片 → 返回 { ok, text }（提示里允许空文字：纯看图）
  async function recognizeImage(b64) {
    const r = await apiFetch('/api/vision', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: b64, prompt: '这是一张用户上传的图片。请描述图片内容；如含文字/代码/报错信息请逐字提取。' })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'vision failed');
    return String(d.text || '').trim();
  }

  // B1: 文件上传。两路分流：
  //  - 小文本（≤6000 字符，受后端 PROMPT_LIMIT=8000 约束）→ 客户端直读，内容内联进 prompt
  //  - 其余（二进制/大文本）→ POST /api/upload 落盘 ~/.hermes/uploads/，注入路径让 Hermes 自己读
  const INLINE_TEXT_EXTS = ['txt','md','markdown','json','csv','tsv','log','js','ts','jsx','tsx','py','rb','go','rs','java','c','cpp','h','hpp','cs','sh','bash','zsh','yaml','yml','toml','ini','cfg','conf','xml','html','css','sql','r','properties','swift','kt','php','lua','diff','patch'];
  const INLINE_MAX_CHARS = 6000;
  const fileBtn = $('fileBtn'), fileInput = $('fileInput'), filePreviewEl = $('filePreview');
  let pendingFile = null;   // { kind:'inline', name, text } | { kind:'path', name, path }
  fileBtn.onclick = () => fileInput.click();
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const isText = INLINE_TEXT_EXTS.includes(ext) && f.size <= 200 * 1024;
    if (isText) {
      const fr = new FileReader();
      fr.onload = () => {
        const text = String(fr.result || '');
        if (text.length <= INLINE_MAX_CHARS) {
          pendingFile = { kind: 'inline', name: f.name, text };
          renderFilePreview();
          return;
        }
        // 文本太大，内联会撞 PROMPT_LIMIT → 转落盘路径模式
        uploadFile(f);
      };
      fr.onerror = () => { alert('无法读取该文件'); };
      fr.readAsText(f);
    } else {
      uploadFile(f);
    }
  });
  async function uploadFile(f) {
    pendingFile = { kind: 'uploading', name: f.name };
    renderFilePreview();
    try {
      const buf = await f.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      const r = await apiFetch('/api/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: f.name, data: btoa(bin) })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'upload failed');
      pendingFile = { kind: 'path', name: f.name, path: d.path };
    } catch (e) {
      pendingFile = null;
      alert('文件上传失败: ' + (e.message || e));
    }
    renderFilePreview();
  }
  function renderFilePreview() {
    if (!pendingFile) { filePreviewEl.classList.remove('show'); filePreviewEl.innerHTML = ''; return; }
    filePreviewEl.classList.add('show');
    const note = pendingFile.kind === 'inline' ? ' · 内容将随消息一起发送'
      : pendingFile.kind === 'path' ? ' · 已存盘，发送时把路径交给 Hermes 读取'
      : ' · 正在上传…';
    filePreviewEl.innerHTML = '<span class="tag">📄 ' + escapeHtml(pendingFile.name) + note
      + '<button type="button" class="rm" title="移除文件" style="position:static;display:inline-block;margin-left:8px;vertical-align:middle">✕</button></span>';
    filePreviewEl.querySelector('.rm').onclick = () => { pendingFile = null; renderFilePreview(); };
  }
  function filePromptSuffix(pf) {
    if (pf.kind === 'inline') {
      return '\n\n[用户上传了文件 ' + pf.name + '，以下是完整内容]\n<<<<FILE\n' + pf.text + '\nFILE>>>>';
    }
    return '\n\n[用户上传了文件，已保存到本地路径：' + pf.path + '。请先用文件读取工具查看该文件内容，再回答。]';
  }

  // 豆包式"为你推荐"：回答结束后用当前模型后台生成 3 条追问磁贴，点击即发送。
  // 失败/超时静默（后端保证返回空数组），新一轮开始时清除旧磁贴。
  let suggestSeq = 0;
  function removeSuggestions() { const s = messagesEl.querySelector('.suggest'); if (s) s.remove(); }
  async function maybeSuggest(answerText) {
    if (!answerText || answerText.length < 20) return;
    const seq = ++suggestSeq;
    try {
      const r = await apiFetch('/api/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: answerText, model: modelSelect.value }) });
      const d = await r.json();
      if (seq !== suggestSeq || busy || !d.suggestions || !d.suggestions.length) return;
      removeSuggestions();
      const panel = document.createElement('div');
      panel.className = 'suggest';
      panel.innerHTML = '<div class="suggest-label">为你推荐</div>';
      for (const q of d.suggestions) {
        const chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'chip';
        chip.textContent = q;
        chip.onclick = () => { if (!busy) { removeSuggestions(); send(q); } };
        panel.appendChild(chip);
      }
      messagesEl.appendChild(panel);
      scrollDown();
    } catch (e) { /* 建议失败不影响主流程 */ }
  }

  async function send(promptOverride, allowDangerous) {
    let prompt = (promptOverride != null ? promptOverride : inputEl.value).trim();
    // /kb 知识库召回：手动命令，检索后以卡片插入对话，不交给模型
    if (promptOverride == null && prompt.startsWith('/kb ')) {
      runKb(prompt.slice(4).trim());
      return;
    }
    if (busy) {
      // 用户主动中断：轨迹要按「已中止」收尾，不能留一个永远转圈的阶段
      trajFinish(currentRunEl, false);
      try { await apiFetch('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: currentRunId, sessionId }) }); } catch (e) { softFail('请求停止本轮', e); }   // 尽力而为：真正的兜底是断开 SSE
      return;
    }
    const img = (promptOverride == null) ? pendingImg : null;   // 仅手动发送带图
    let pf = (promptOverride == null) ? pendingFile : null;     // 仅手动发送带文件
    if (pf && pf.kind === 'uploading') pf = null;               // 还在上传中的附件本次不带
    if (!prompt && !img && !pf) return;
    if (img) { pendingImg = null; renderImgPreview(); }
    if (pf) { pendingFile = null; renderFilePreview(); }
    lastPrompt = prompt;
    // 会话视图顶栏：新会话首轮即以本条指令为标题（gateway 侧标题同源取自 prompt）
    if (!sessionId) setConvTitle(prompt || (img ? '图片对话' : '新会话'), true);
    const es0 = messagesEl.querySelector('.empty-state');
    if (es0) { mountComposer(false); es0.remove(); }   // 首条消息：输入卡回底部 + 移除 Hero 空态
    if (promptOverride == null) {
      addUserMsg(prompt || (img ? '📷 附图' : '📄 附文件'), img ? img.dataUrl : null);
      inputEl.value = ''; inputEl.style.height = 'auto';
    }
    liveText = ''; tokenIgnore = false; curStats = null;
    currentRunEl = createRunPanel(); setBusy(true);
    removeSuggestions();   // 新一轮开始，清掉上一轮的推荐磁贴
    try {
      let finalPrompt = prompt;
      // B1: 带文件 → 内联内容或注入落盘路径
      if (pf) finalPrompt += filePromptSuffix(pf);
      // C4: 带图 → 先由 gemma4 识别（与对话同一模型，不再换载），识别文本并入上下文再走主模型
      if (img) {
        setAnswer(currentRunEl, '🔍 gemma4 正在识别图片…');
        try {
          const vis = await recognizeImage(img.b64);
          if (vis) {
            finalPrompt = (prompt ? prompt + '\n\n' : '')
              + '[用户上传了一张图片，以下是 gemma4 的识别结果，请基于此回答/继续。图片识别结果不一定准确，必要时说明。]\n'
              + vis;
            lastPrompt = finalPrompt;
          }
        } catch (e) {
          setAnswer(currentRunEl, '图片识别失败: ' + escapeHtml(e.message));
          setBusy(false); currentRunId = null; currentRunEl = null;
          return;
        }
      }
      const resp = await apiFetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: finalPrompt, sessionId, model: modelSelect.value,
          allowDangerous: !!allowDangerous || wsModOn,          // 卡内「工作区内修改」开关与审批重跑共用一条放行链路
          workspace: (!sessionId && activeWs) ? activeWs : '',  // 仅新会话首轮传工作区，服务端 assignIfNew 只在无归属时写入
        })
      });
      const reader = resp.body.getReader(); const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) { const frame = buf.slice(0, idx); buf = buf.slice(idx + 2); handleFrame(frame); }
      }
      if (buf.trim()) handleFrame(buf);
    } catch (e) {
      if (currentRunEl) setAnswer(currentRunEl, '请求失败: ' + escapeHtml(e.message));
      setBusy(false); currentRunId = null; currentRunEl = null;
    }
  }

  // B5: 新会话空态（工作台 Hero 页，第三步：品牌行 + 居中输入卡 + 幽灵磁贴）
  const HERO_MARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13.5 20.5 4l-6 16.5-3-6.5z"/><path d="m11.5 14 9-10"/></svg>';
  const CHIP_PROMPTS = [
    '用 terminal 看看当前工作区有哪些文件，简单介绍下',
    '用 terminal 检查一下 Ollama 服务和本地模型状态',
    '列出你能使用的技能，挑 3 个最实用的介绍给我',
    '写一个 Python 脚本，统计 ~/.hermes/skills 下技能的数量',
  ];
  function renderEmptyState() {
    const es = document.createElement('div'); es.className = 'empty-state';
    es.innerHTML = '<div class="hero-row"><div class="hero-mark">' + HERO_MARK + '</div>'
      + '<h2>赫尔墨斯特工</h2><span class="hero-pill">本地优先</span></div>'
      // dsh 同位：标题下方一行上下文 chip（工作区选择；模式/模型在输入卡内）
      + '<div class="hero-ctx"><select id="heroWs" title="新会话将归入所选工作区"></select></div>'
      + '<div class="chip-grid"></div>';
    const grid = es.querySelector('.chip-grid');
    for (const q of CHIP_PROMPTS) {
      const c = document.createElement('button'); c.className = 'chip'; c.type = 'button'; c.textContent = q;
      c.onclick = () => { inputEl.value = q; inputEl.style.height = 'auto'; send(); };
      grid.appendChild(c);
    }
    messagesEl.appendChild(es);
    mountComposer(true);   // 空态：输入卡上移到 Hero 标题下方（参照工作台布局）
  }

  // 输入卡挂载位切换：Hero 空态时卡片居中在标题下方，进入会话后回到底部。
  // DOM 搬移保留事件接线；⚠️ 任何要清空 #messages 的路径必须先 mountComposer(false)，
  // 否则位于 .empty-state 内的输入卡会被连带 innerHTML='' 销毁（事件接线全灭）。
  function mountComposer(inHero) {
    const comp = document.getElementById('composer');
    if (!comp) return;
    comp.classList.toggle('hero-mode', !!inHero);
    if (inHero) {
      const es = messagesEl.querySelector('.empty-state');
      if (es && comp.parentElement !== es) es.appendChild(comp);
    } else {
      const mainEl = messagesEl.parentElement;   // <main>
      if (comp.parentElement !== mainEl) mainEl.appendChild(comp);
    }
  }

  // 会话视图顶栏：显示/隐藏 + 设标题（t 为 null 时只切换可见性）
  function setConvTitle(t, show) {
    const head = $('convHead'), el = $('convTitle');
    if (!head || !el) return;
    if (t != null) el.textContent = t || '新会话';
    head.style.display = show ? '' : 'none';
  }
  // 会话视图顶栏右侧：工作区归属（空串清空）
  function setConvMeta(t) {
    const el = $('convMeta');
    if (el) el.textContent = t ? '📁 ' + t : '';
  }

  function newChat() { mountComposer(false); sessionId = null; currentRunId = null; currentRunEl = null; messagesEl.innerHTML = ''; renderEmptyState(); setConvTitle('新会话', false); updateHint(); loadSessions(); }

  sendBtn.onclick = () => send();
  $('newChat').onclick = newChat;
  // 工作台改版：侧栏顶部新会话按钮与头部「新对话」同逻辑
  if ($('newChatSide')) $('newChatSide').onclick = newChat;
  // dsh 式「工作区内修改」开关：即 allowDangerous 的卡内可见形态（安全 hook 仍兜底）
  const wsModBtnEl = $('wsModBtn');
  if (wsModBtnEl) wsModBtnEl.onclick = () => {
    wsModOn = !wsModOn;
    wsModBtnEl.classList.toggle('on', wsModOn);
    addNote(wsModOn
      ? '⚠️ 工作区内修改已开启：agent 可执行终端等高危工具（到期自动恢复拦截）'
      : '工作区内修改已关闭', wsModOn ? 'cloud' : '');
    updateHint();
  };
  // 移动端适配：≤720px 侧栏变抽屉 + 遮罩；桌面端行为不变（.hidden 控制收合）
  const backdrop = $('backdrop');
  const isMobile = () => window.innerWidth <= 720;
  function setSideDrawer(show) {
    $('sidebar').classList.toggle('hidden', !show);
    if (backdrop) backdrop.classList.toggle('show', show && isMobile());
  }
  $('toggleSide').onclick = () => setSideDrawer($('sidebar').classList.contains('hidden'));
  if (backdrop) backdrop.onclick = () => setSideDrawer(false);
  if (isMobile()) $('sidebar').classList.add('hidden');   // 手机默认收起
  // 手机↔桌面切换（旋转/拉窗口）：跨越瞬间清掉抽屉态，恢复桌面内联侧栏；
  // 桌面端用户手动收起的 .hidden 不被打扰
  let wasMobile = isMobile();
  window.addEventListener('resize', () => {
    const m = isMobile();
    if (wasMobile && !m) { $('sidebar').classList.remove('hidden'); if (backdrop) backdrop.classList.remove('show'); }
    if (!wasMobile && m) { $('sidebar').classList.add('hidden'); if (backdrop) backdrop.classList.remove('show'); }
    wasMobile = m;
  });
  // B2: 历史搜索（防抖）
  let searchTimer = null;
  $('sessSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadSessions, 180); });
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  inputEl.addEventListener('input', () => { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px'; });

  updateHint();
  // 有 token 直接加载，否则弹登录
  if (getToken()) { loadSessions(); loadWorkspaces(); loadModels(); refreshStatus(); renderEmptyState(); }
  else showLogin();

  // 会话列表自愈：以前只在加载时取一次，任何一次失败（服务没就绪/重启中/网络抖动）
  // 都得手动刷新才能恢复。改为：
  //   ① 切回页面/窗口聚焦/网络恢复时立即刷新 —— 覆盖最常见的"切走再切回来"
  //   ② 页面可见时每 60s 轻量轮询兜底（/api/sessions 会 spawn 一个 hermes 子进程，
  //      单次 ~0.4s，别设太密；不可见时跳过，不浪费 CPU）
  //   ③ 加载中防重入，避免请求堆积
  let sessLoading = false;
  const loadSessionsOnce = () => {
    if (sessLoading || !getToken()) return;
    sessLoading = true;
    Promise.resolve(loadSessions()).finally(() => { sessLoading = false; });
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadSessionsOnce(); });
  window.addEventListener('focus', loadSessionsOnce);
  window.addEventListener('online', loadSessionsOnce);
  setInterval(() => { if (!document.hidden) loadSessionsOnce(); }, 60000);
})();
