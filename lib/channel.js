'use strict';
/* =============================================================================
 * lib/channel.js —— 渠道适配抽象层 · 阶段 0：**只定义契约，不接任何真实渠道**
 *
 * 由来（OpenClaw 借鉴清单第 5 条 + docs/CHANNEL-STRATEGY.md）：
 *   渠道是 OpenClaw 最强的一维，也是本项目「零出网 + loopback」安全优势最容易被拖平的一维
 *   （ClawJacked CVE-2026-25253 正是从渠道/网关破的）。故**默认不做**。
 *   本模块只把「如果将来要做，接口长什么样」固定下来 —— 不实现任何渠道、不出网、不加端口。
 *
 * ⚠️ 设计意图：这不是「预留的空壳」，而是**把安全决策编码进契约**。
 *   assertAdapter() 会主动拒绝违反 CHANNEL-STRATEGY.md 的适配器：
 *     · inbound 必须是 'pull'（出站长轮询）——**拒绝 webhook 式 push**，那是 ClawJacked 病根；
 *     · 五道闸门必须显式声明为已内置（白名单/首次配对/危险操作不放宽/会话车道守卫/附件隔离）；
 *     · 不得声明 mayGrantDangerous:true —— 危险操作只能由本机 Web UI 授予。
 *   于是「想接一个不安全的渠道」在**注册那一刻**就失败，而不是等到线上出事。
 *
 * ⚠️ 本模块**未接入任何 live 路径**（chat.js 等仍走原有逻辑）。这是刻意的：
 *   没有真实渠道消费者时改动热路径 = 纯风险。等真要接渠道时，再让真实需求驱动接线。
 *   参考适配器 `webAdapter` 的存在意义是「证明契约可被实现」，由 test/channel.test.js 覆盖。
 * ========================================================================== */

/** 归一化入站消息（各平台 payload → 这个统一结构） */
function makeMsgContext({
  channel, senderId, text, attachments, threadId, receivedAt, raw,
} = {}) {
  return {
    channel: String(channel || ''),
    senderId: String(senderId || ''),
    text: String(text || ''),
    attachments: Array.isArray(attachments) ? attachments.slice() : [],
    threadId: threadId == null ? null : String(threadId),   // 会话/话题标识（DM 为 null）
    receivedAt: Number(receivedAt) || Date.now(),
    raw: raw === undefined ? null : raw,                     // 原始 payload，排障用；不参与安全判断
  };
}

/** 归一化出站消息（统一回复 → 平台格式由 adapter.renderOutbound 负责） */
function makeOutbound({ text, attachments, replyTo } = {}) {
  return {
    text: String(text || ''),
    attachments: Array.isArray(attachments) ? attachments.slice() : [],
    replyTo: replyTo == null ? null : String(replyTo),
  };
}

/* 五道闸门（CHANNEL-STRATEGY.md §三「必须内置的闸门」）。
 * 缺任一条 → 适配器不允许注册。 */
const REQUIRED_GATES = [
  'allowlist',          // 发送者白名单：非白名单静默丢弃 + 记日志
  'firstPairing',       // 首次配对：未知发送者需本机 Web UI 确认
  'dangerousNotRelaxed',// 渠道来消息照样走三色权限 + safety hook + 检查点
  'sessionLaneGuard',   // (渠道,对方ID)↔session 映射复用会话车道并发守卫
  'attachmentIsolation',// 附件走 media.js 加固 + 独立目录
];

/**
 * 契约校验：不合格直接抛错（fail-fast 在注册期，不是运行期）。
 * @param {object} adapter
 */
function assertAdapter(adapter) {
  const where = 'ChannelAdapter';
  if (!adapter || typeof adapter !== 'object') throw new Error(`${where} 必须是对象`);
  const id = String(adapter.id || '').trim();
  if (!id) throw new Error(`${where} 缺少非空 id`);

  // ① 方向必须是出站拉取 —— 拒绝 webhook 式（要开入站端口 = 攻击面 = ClawJacked 病根）
  if (adapter.inbound !== 'pull') {
    throw new Error(
      `渠道 ${id} 的 inbound 必须是 'pull'（出站长轮询）。` +
      `webhook/push 式接入要求开入站端口，是 ClawJacked（CVE-2026-25253）的病根，` +
      `本项目禁止（见 docs/CHANNEL-STRATEGY.md §三）。`
    );
  }

  // ② 危险操作不得由渠道放宽
  if (adapter.mayGrantDangerous === true) {
    throw new Error(
      `渠道 ${id} 不得声明 mayGrantDangerous:true —— 危险操作只能由本机 Web UI 授予` +
      `（见 docs/CHANNEL-STRATEGY.md §三 闸门 3）。`
    );
  }

  // ③ 五道闸门必须全部声明
  const gates = adapter.gates || {};
  const missing = REQUIRED_GATES.filter((g) => gates[g] !== true);
  if (missing.length) {
    throw new Error(`渠道 ${id} 缺少必需闸门：${missing.join(', ')}（见 docs/CHANNEL-STRATEGY.md §三）`);
  }

  // ④ 三职责必须是函数
  for (const fn of ['normalizeInbound', 'renderOutbound', 'verifyAuth']) {
    if (typeof adapter[fn] !== 'function') throw new Error(`渠道 ${id} 缺少方法 ${fn}()`);
  }
  return adapter;
}

/* ---------- 注册表（进程内；不落盘 —— 阶段 0 不需要持久化） ---------- */
const registry = new Map();

function registerAdapter(adapter) {
  assertAdapter(adapter);
  const id = String(adapter.id);
  if (registry.has(id)) throw new Error(`渠道 ${id} 已注册（id 必须唯一）`);
  registry.set(id, adapter);
  return adapter;
}

function getAdapter(id) {
  const a = registry.get(String(id));
  if (!a) throw new Error(`未注册的渠道：${id}`);
  return a;
}

function listAdapters() {
  return [...registry.values()].map((a) => ({ id: a.id, label: a.label || a.id, inbound: a.inbound }));
}

/** 测试用：清空注册表（生产代码不该调它） */
function _clearAdaptersForTest() { registry.clear(); }

/* ---------- 门面：id → 契约调用（内部统一做注册校验） ---------- */
async function normalizeInbound(id, platformMsg, ctx) {
  return makeMsgContext(await getAdapter(id).normalizeInbound(platformMsg, ctx));
}
async function renderOutbound(id, reply) {
  return getAdapter(id).renderOutbound(makeOutbound(reply));
}
async function verifyAuth(id, req) {
  return !!(await getAdapter(id).verifyAuth(req));
}

/* ---------- 参考适配器：把本机 Web UI 当作第一个「渠道」----------
 * 作用：证明本契约**可被实现**（由 test/channel.test.js 做一致性验证），
 * 并给将来真正的渠道（如 Telegram 长轮询）一个照抄的模板。
 * ⚠️ 未接入 live 路径 —— /api/chat 仍走原逻辑，此对象仅供契约自证与模板参考。 */
const webAdapter = {
  id: 'web',
  label: 'Web UI（本机 127.0.0.1:4173，出站方向不适用）',
  inbound: 'pull',            // Web UI 是浏览器主动来取，无入站端口
  mayGrantDangerous: false,   // 危险授权由 UI 按钮 + /api/chat 的 allowDangerous 走原链路
  gates: {
    allowlist: true,          // Bearer token 即白名单（~/.hermes/ui_token）
    firstPairing: true,       // 本机部署即隐含已配对；远程接入需另配
    dangerousNotRelaxed: true,// allowDangerous 仍走 lib/safety.js 文件放行 + TTL
    sessionLaneGuard: true,   // 复用 ② 的 active 会话车道
    attachmentIsolation: true,// 上传走 uploads/ 独立目录 + 保留期清理
  },
  // /api/chat 的 body → MsgContext
  normalizeInbound(body) {
    const b = body || {};
    return {
      channel: 'web',
      senderId: 'local-user',
      text: b.prompt || '',
      attachments: b.attachments || [],
      threadId: b.sessionId || null,
      receivedAt: Date.now(),
      raw: b,
    };
  },
  // 统一回复 → Web UI 的 SSE 帧（同 lib/http.js 的 sse 形状）
  renderOutbound(reply) {
    const r = reply || {};
    return { event: 'token', data: { text: String(r.text || '') } };
  },
  // 本机 Bearer token 校验（真值由 server.js 的鉴权闸门负责，这里只做形状判定）
  verifyAuth(req) {
    const h = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    return /^Bearer\s+\S+/.test(String(h));
  },
};

module.exports = {
  makeMsgContext, makeOutbound,
  assertAdapter, registerAdapter, getAdapter, listAdapters, _clearAdaptersForTest,
  normalizeInbound, renderOutbound, verifyAuth,
  REQUIRED_GATES, webAdapter,
};
