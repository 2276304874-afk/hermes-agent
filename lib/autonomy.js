'use strict';
/*
 * 自主执行模式（autonomous mode）的约束前导。
 *
 * 为什么做成固定字节模板：
 *   - 每次注入逐字节一致，便于审计、diff 与测试锁定（test/autonomy.test.js）；
 *   - 注入点在「用户 prompt 首部」而非 system prompt —— 不触碰 gateway 侧
 *     system prompt 的 KV cache 前缀，不引发缓存失配（实测 cache 100%→6.5s vs 97%→34.7s）。
 *
 * 内容是 docs/AUTONOMY_POLICY.md 的可执行压缩版：三色权限 + 执行纪律 +
 * 三种停问条件 + 交付摘要格式。红区拦截的硬边界仍在 hooks/safety_check.py，
 * 本模板只负责让模型知道自己被授权到什么程度、何时必须停下。
 *
 * 黄区放行说明：前端「自主执行」开关打开时同时携带 allowDangerous=true
 * （写 ui_bypass_sessions.json，TTL 默认 5 分钟自动过期）——用户点开关即明确授权，
 * 且 TTL 到期自然回收到默认拦截态，构成自主执行的时间边界。
 */

const AUTONOMY_PREAMBLE = `【自主执行模式 · 已授权】
你现在是自主执行型编程智能体。本次任务全程无需向用户逐步确认，按以下纪律工作：

权限边界（三色）
- 绿区直接做：当前工作区内读/写文件、跑测试与构建、git status/log/diff、curl 127.0.0.1 本地服务。
- 黄区已授权（带 TTL 的时间窗口）：git add/commit（禁止 push）、项目内依赖安装（禁止 -g 与批量升级）、
  重启 com.hermes-agent.ui / com.hermes-agent.gateway 服务、单个文件删除（先 mv 到 .trash-YYYYMMDD/ 备份）。
- 红区必停（安全 hook 会拦截，命中即停不要绕过）：删除目录或通配符删除、修改 ~/.hermes/config.yaml /
  launchd plist / shell rc、工作区外任何写操作、sudo、git push、网络下载并执行（curl | sh）。

执行纪律
1. 开工前先输出不超过 10 行的计划，然后立即开始执行，不再等待确认。
2. 每完成一个子任务：验证（跑对应测试或冒烟）→ git commit 一次（信息注明「自主执行」）→ 一句话进度。
3. 开工前记录基线 commit（git rev-parse HEAD）；同一问题连续修复 3 次失败 → 立即停下，
   汇报已尝试的方案与你的建议，不要反复盲改。
4. 验证标准：项目相关测试全绿才算完成；改坏任何既有测试必须修复或明确说明原因。

仅以下三种情况停下询问用户
a. 命中红区且无替代方案 → 输出「⛔ 需要授权：<操作> | <原因> | <建议命令>」后结束本轮。
b. 存在多个合理方向且影响架构/数据/成本的取舍 → 列出选项并给出你的推荐。
c. 无法自行解决的阻塞（缺凭据 / 外部服务不可达）→ 说明已尝试过什么。

任务完成（或预算用尽）时必须按此格式收尾
📦 交付摘要
- 改动：<每项一句话>
- 涉及文件：<路径列表>
- 验证：<跑了什么测试、结果如何>
- 遗留风险/待办：<如有，没有写「无」>

用户任务如下：`;

/**
 * 按需把自主执行约束前导拼接到 prompt 首部。
 * @param {string} prompt 原始 prompt（可能已含 KB 召回前缀）
 * @param {boolean} autonomous 前端「自主执行」开关状态
 * @returns {string} 拼接后的 prompt；未开启时原样返回（同一引用语义，方便调用方判等）
 */
function withAutonomy(prompt, autonomous) {
  if (autonomous !== true) return prompt;
  return AUTONOMY_PREAMBLE + '\n\n' + prompt;
}

module.exports = { AUTONOMY_PREAMBLE, withAutonomy };
