'use strict';
/* =============================================================================
 * lib/stall.js —— 模型 stall（首 token 超时）降级决策（OpenClaw Model Failover 借鉴）
 *
 * 场景：本地单机、16G 统一内存。主模型冷加载或与同机其他模型争显存时，
 * 首 token 可能长时间不来（实测最多静默挂起 200s）。现状只有「提示 + 5 分钟空闲看门狗」，
 * 即只能告知、不能自救。本模块给出「换更小的常驻备用模型重跑本轮」的**纯决策**。
 *
 * ⚠️ 默认关闭（HERMES_STALL_SEC 未设 = 0），必须显式开启才生效 —— 原因见下：
 *
 * 本机（16G）的关键约束：同时只容得下**一个** ≥8B 模型驻留
 *   （gemma4:e4b 9.5G / qwen3:8b 7.4G，双驻 ≈17G > 16G → swap）。
 * 因此「降级」若换来的是**一个没驻留的备用模型**，就要先驱逐主模型再冷加载备用模型，
 * 于是：这一轮慢上加慢，且下一轮正常请求还得再冷加载一次主模型 ——
 * **比原地等的代价更大**。故 `fallbackResident === false` 时一律不降级（hard guard）。
 * 也就是说：只有当备用模型**恰好已经驻留**时，降级才是净收益。
 *
 * 另一个硬边界：**只在首 token 之前**降级。已经吐过字再换模型，用户看到的是两段
 * 拼接的回答（甚至前后矛盾），比卡住更糟。
 * ========================================================================== */

/**
 * 读 stall 配置。纯函数，便于单测（传入自定义 env）。
 * @returns {{sec: number, fallback: string}} sec=0 表示关闭
 */
function stallConfig(env = process.env) {
  const raw = Number(env.HERMES_STALL_SEC);
  const sec = Number.isFinite(raw) && raw > 0 ? raw : 0;
  return { sec, fallback: String(env.HERMES_FALLBACK_MODEL || '').trim() };
}

/**
 * 是否降级、降级到哪个模型。**纯函数**——所有 I/O（备用模型是否驻留）由调用方查好后传入。
 *
 * @param {object} o
 * @param {boolean} o.firstTokenSeen  本尝试是否已收到首 token
 * @param {number}  o.attempts        已降级次数（≥1 即不再降，只降一级）
 * @param {number}  o.sec             stall 阈值秒（0 = 关闭）
 * @param {string}  o.model           当前正在用的模型
 * @param {string}  o.fallback        备用模型（空 = 未配置）
 * @param {boolean} o.fallbackResident 备用模型是否已驻留（未驻留 = 不降，见文件头）
 * @returns {{action:'retry', model:string} | {action:'none', reason:string}}
 */
function failoverPlan({ firstTokenSeen, attempts, sec, model, fallback, fallbackResident } = {}) {
  if (!(Number(sec) > 0)) return { action: 'none', reason: 'disabled' };
  if (firstTokenSeen) return { action: 'none', reason: 'already-streaming' };
  if (Number(attempts) >= 1) return { action: 'none', reason: 'retry-exhausted' };
  if (!fallback) return { action: 'none', reason: 'no-fallback' };
  if (fallback === model) return { action: 'none', reason: 'same-model' };
  if (!fallbackResident) return { action: 'none', reason: 'fallback-cold' };
  return { action: 'retry', model: fallback };
}

module.exports = { stallConfig, failoverPlan };
