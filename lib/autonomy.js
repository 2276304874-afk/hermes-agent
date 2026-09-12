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

/* 停止条件（提示词层，2026-09-12 新增）。
 *
 * 为什么要有它：服务端裁判（lib/stopjudge.js）只能在事后观测到"已经在打转"，
 * 模型自己才是能提前止损的一方。两处真实跑偏都不是"做错"，而是**停不下来**：
 *   ① 上下文被吃满后失忆，把"做旅行网站"退化成写 hello-world 原型 demo；
 *   ② 反复用同样参数重试同一条命令，每次拿到同样的失败结果，绕不出来。
 * 这三条把"何时算完 / 何时算卡住"变成可判定的条件，并要求给出验证方式 ——
 * 没有"停止条件"的自主执行，等于把预算交给模型的乐观程度。
 *
 * 字节稳定性同样重要（见文件头）：本块是固定模板，追加在 META_GUARD 之前，
 * 只在用户消息侧增 token，不触碰 system prompt 缓存前缀。 */
const STOP_RULES = `
[停止条件] 动手前先用一行写清「完成标准」；满足以下任一条就立刻停止调用工具并汇报：
1. 完成标准已达成且你亲自验证过（说明验证方式：跑了什么、看到什么）；
2. 同一工具调用重复出现且没有带来新信息或文件变化 —— 方向错了，停下说明卡点，不要换参数空转；
3. 同一处修复失败 3 次。
不要用「再试一次」代替思考；收尾时给出结论与涉及文件。`;

/*
 * 元技能防误触守卫（2026-09-12 旅行网站排障产物）。
 *
 * 背景：hermes 的 system prompt 里有 HERMES_AGENT_HELP_GUIDANCE——「涉及自身
 * 功能/工具/能力时先 skill_view('hermes-agent')」。小模型（gemma4）把任务里
 * 出现的工具名（如「用 search_files 工具」）误判为「想了解自身能力」，稳定
 * 复现以下脱轨链：正常调工具 → 成功拿到结果 → 却去 skill_view('hermes-agent')
 * → 15KB 技能文撞 spillover → 回答「skill loaded, ready」当成交付。
 * 实测 5/5 复现（含全新会话），与会话历史无关，是 prompt 级误路由。
 *
 * 修法：在本 UI 下发的每条用户 prompt 尾部追加固定字节守卫（不动 system
 * prompt、不破 KV cache 前缀；用户消息本就是新增 token，无缓存代价）。
 * 明确本会话任务与 Hermes 自身无关，封掉 skill_view 这条歧义路径。
 */
const META_GUARD = `
[任务边界] 本任务由特工工作台 UI 直接下发，是用户的实际工作任务，与 Hermes 自身的配置、安装、功能或技能体系完全无关。因此：不要调用 skill_view（尤其禁止加载 hermes-agent 元技能），不要输出「技能已加载/我已就绪」这类元话语，不要回答关于你自身身份的问题，不要自行发明或替换任务（严格按用户指令执行，指令没让创建文件就不要创建）——收到工具结果后立即继续任务，完成后向用户交付具体结果。`;

/**
 * 按需把自主执行约束前导拼接到 prompt 首部；并始终追加「停止条件 + 元技能守卫」尾缀。
 * @param {string} prompt 原始 prompt（可能已含 KB 召回前缀）
 * @param {boolean} autonomous 前端「自主执行」开关状态
 * @returns {string} 拼接后的 prompt；未开启自主时原 prompt + 尾缀
 */
function withAutonomy(prompt, autonomous) {
  if (autonomous !== true) return prompt + STOP_RULES + META_GUARD;
  return AUTONOMY_PREAMBLE + '\n\n' + prompt + STOP_RULES + META_GUARD;
}

module.exports = { AUTONOMY_PREAMBLE, META_GUARD, STOP_RULES, withAutonomy };
