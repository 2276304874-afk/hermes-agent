# 检查点回退 + 停止条件裁判 · 接线文档

> 一句话：给 agent 装上**后悔药**（改坏了能一键回到上一步）和**仪表盘**（在打转时让你看见）。
> 落地日期：2026-09-12。本文是这两项能力的真源；代码注释与之重复是刻意的（改代码时不用翻文档）。

---

## 一、检查点回退

### 1.1 为什么自己实现，而不是转发 hermes 的 `/rollback`

hermes 有完整的 `/rollback` 实现（`gateway/slash_commands.py:669`，含 safe-mode 跳过计数渲染），
但它**只在 `_IDLE_COMMANDS` 表里、由平台消息管线派发**（`gateway/run_busy.py:704`），
而 gateway 的 `api_server` 适配器**不做斜杠命令分发**。

实测否证（2026-09-12）：往 `/api/sessions/{id}/chat/stream` 发 `/version`，
请求被当成**普通消息喂给模型**——模型一本正经地编了 "I am Hermes Agent, built by Nous Research"。
即：斜杠命令在 Web UI 这条链路上是死的，不是配置问题。

**结论**：路径 A（转发）不可行，改为在 Node 侧直接读写影子库（`lib/checkpoints.js`）。
好处是不碰 hermes 源码、不回退到 `serve`，安全边界不变。

### 1.2 影子库契约

`~/.hermes/checkpoints/store/` 是**单个共享 bare git 库**——跨项目按内容去重，
**绝不碰用户项目自己的 `.git`**。

```
store/                          bare git
store/refs/hermes/<hash16>      每项目一条 ref
store/indexes/<hash16>          每项目独立 index
store/projects/<hash16>.json    {workdir, created_at, last_touch}
store/ledgers/<hash16>.json     agent 写入台账 {absPath: {sha256, ts}}
store/info/exclude              全局排除（node_modules/.git/媒体/密钥…，21 类）
```

`<hash16> = sha256(realpath(workdir))[:16]`。

⚠️ 用 **realpath** 而非路径字符串：Python 侧 `Path.resolve()` 解符号链接，
macOS 上 `/tmp` → `/private/tmp` 这类差异会让同一目录算出**两个 hash**，
表现为「检查点明明在、按路径却查不到」。

### 1.3 三条语义（照抄 `checkpoint_manager.py`，勿自行发挥）

| 语义 | 内容 |
|---|---|
| 快照时机 | 必须在**本回合首次写文件之前**拍；每目录每回合最多一张；无差异则跳过 |
| 安全回退（默认） | 只覆盖「台账里记录过、**且当前内容仍等于 hermes 最后写入**」的文件；用户手改过的文件一律跳过 |
| 台账为空时 | 退回整目录回退（`all=true`，需 `confirm=true`） |
| pre-rollback 快照 | 回退**前**先拍一张 → 于是"撤销的撤销"也在列表里可回 |

### 1.4 硬护栏与实测坑

- **`$HOME` 与 `/` 永不进入快照**（`ensure_checkpoint` 里 `abs_dir in {"/", str(Path.home())}`）。
  实测：让 agent 往 `~/cp-probe.txt` 写文件确实落盘了，但**不产生任何检查点**。
  表现为「我明明让它写文件了，列表却是空的」——这不是坏了，是护栏。
- **项目根由 `_PROJECT_MARKERS` 向上就近判定**（`.git` / `package.json` / `pyproject.toml`…）。
  往 `<项目>/子目录/x.txt` 写，快照的是**整个项目根**，不是那个子目录。
- **hermes 官方默认关闭**：`checkpoints_enabled: bool = False` 是 `run_agent.py:269` 的构造参数默认值，
  v2 起 opt-in。我们此前一直以为"这功能是坏的"，实为从未开启 —— 影子库 0 B / 0 项目空转。

### 1.5 ★ 双重守卫（一次真实事故换来，勿删）

影子库是**单个共享 git 库**，因此 store 里任何提交对任何 workdir 都 `cat-file` 可见。
只检查"提交存在"**不够**：把某个已注册项目当 workdir、配一个无关提交，
`git checkout <hash> -- .` 会把**整个项目树**写到那个目录里去。

> 实测事故：对未注册的 `/tmp` 调 `restore`，结果整个项目被 checkout 进 `/private/tmp`（118 个文件）。

`guard()` 必须同时满足两条，缺一不可：

1. workdir 必须是**已注册的检查点项目**（`resolveWorkdir()` 命中 `projects/<hash16>.json`）；
2. 目标提交必须在**该项目自己的 ref 历史**里（`git merge-base --is-ancestor <hash> <ref>`）。

### 1.6 API 端点

全部在认证闸门之后，`/api/checkpoints/*` 与主令牌同权。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/checkpoints` | 库状态（enabled / sizeBytes / 上限）+ 已登记项目；带 `workspace` 与 `workspaceRegistered` |
| GET | `/api/checkpoints/list?dir=&limit=` | 检查点列表（含 pre-rollback 快照） |
| GET | `/api/checkpoints/plan?dir=&hash=` | 影响范围预案 → `{restore[], skipped[], ledgerEmpty}` |
| GET | `/api/checkpoints/diff?dir=&hash=&stat=1` | 差异预览 |
| POST | `/api/checkpoints/snapshot` | 手动拍快照 |
| POST | `/api/checkpoints/restore` | 回退（`all=true` 时必须带 `confirm=true`） |

⚠️ **路由注册必须用精确路径匹配器**：

```js
router.add('GET', (req) => req.url.split('?')[0] === '/api/checkpoints', handler)
```

`lib/router.js` 是**前缀匹配 + 首个命中即处理**，写成 `router.add('GET','/api/checkpoints',…)`
会连 `/list`、`/plan`、`/diff` 一起吞掉（实测踩坑：`/api/checkpoints/list` 返回总览 JSON）。

### 1.7 UI 入口与交互

header 的时钟回溯图标 `#cpBtn` → `#cpMask` 模态框（项目下拉 / 快照按钮 / 列表 / 影响范围两栏）。

**交互约定：行内「回退…」按钮不直接落地**，只展开影响范围，由用户在预览里确认后再点执行。
理由：一次点击就覆盖别人的项目文件太廉价了，回退必须是"看过影响范围后"的动作。

### 1.8 容量

- 单项目上限 `max_snapshots: 20`；单文件上限 10MB；全库上限 300MB。
- `take()` 结尾会 `prune(wd, ref)` + `enforceSizeCap()`：超限按项目轮转丢最旧，**每项目至少留 1 张**，最后 `gcStore()`。
- 补齐缘由：曾出现 837 个松散对象里只有 162 个可达（25MB 垃圾）；
  `reflog expire --expire=now --all` + `gc --prune=now` 回收到 489KB（1 pack）。

### 1.9 ⚠️ git 隔离纪律（安全）

所有影子库 git 调用必须：

- `GIT_CONFIG_GLOBAL=os.devNull`、`GIT_CONFIG_SYSTEM=os.devNull`、`GIT_CONFIG_NOSYSTEM=1`
- 清掉 `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_NAMESPACE` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` 泄漏

**绝不让使用者的 gitconfig（gpg 签名 / hooks / credential helper）介入后台快照。**

---

## 二、`terminal.cwd` —— 检查点能触发的**前置条件**

检查点的 cwd 硬护栏（§1.4）带来一个隐蔽后果：
**agent 的工作目录必须落在项目里，否则快照永不触发。**

实测事故：gateway 模式下让 agent「在当前工作目录创建 cp-probe.txt」，
文件落在 `/Users/zhaocaozheng/`。后果有二 ——
① 往家目录乱写；② `$HOME` 是硬护栏 → **检查点永久失效**（修复前完全不可能触发）。

修法（`~/.hermes/config.yaml`）：

```yaml
terminal:
  cwd: /Users/zhaocaozheng/WorkBuddy/赫尔墨斯特工   # 必须是绝对路径
```

修复后实测：同一 prompt 文件落在项目目录，且检查点**真的触发了**
（日志 "before write_file"，569.7 KB / 1 提交）。

> 遗留：`-z --in` 不约束 terminal cwd，所以 cwd 的真源现在有**两处**
> （`terminal.cwd` 与 `-z --in`）。healthcheck §10 已加断言钉住前者。

---

## 三、停止条件裁判

### 3.1 它治什么

提示词层面的"跑偏"治理已经做过（`lib/autonomy.js` 三色纪律 + 任务边界守卫），
但**提示词只能"请求"模型别打转，模型照样会**。真实复现过两类：

1. 上下文被吃满后失忆，把「做旅行网站」退化成写 hello-world 原型 demo（跨模型确定性复现）；
2. 反复用同样参数重试同一条命令，每次都拿到同样的失败结果，绕不出来。

这两类都不是"错"，而是**停不下来** —— 缺一个不依赖模型自觉的外部裁判。

### 3.2 判据（都只依赖 state.db 已轮询到的行，不额外调模型、不加延迟）

| 判据 | 条件 | 级别 |
|---|---|---|
| D1 `repeat` | 同一工具调用（名字 + 参数摘要）在一次 run 内重复 ≥3 次 | `warn` |
| D2 `same_result` | 同一调用 **+ 工具返回正文完全相同** ≥2 次（= 卡死，不是探索） | `hard` |
| D3 `budget` | 一次 run 内工具调用总数 > 40（失控式刷工具） | `hard` |

- 严重度**单调只升不降**：`hard` 不会被后续 `warn` 冲掉。
- 同一 `code` 只报一次（`fired` 去重）——每轮刷同一条告警等于没有告警。
- 结果归因用 `lastSig`（最后一次调用的签名）而非 Map 插入序：
  Map 保插入序，重复调用老签名时它不在末尾，会导致归因错工具。
- 参数归一化：对象键排序，避免键序差异造成"同一次调用两种签名"。

### 3.3 ⚠️ 设计取舍：只报告，不中断

默认**绝不 abort**。长任务里"看起来在重复"是常态（轮询、渐进重试）。
裁判的价值在于让用户**及时看到"它在打转"**，而不是替用户做决定。
要强制中断需显式设 `HERMES_JUDGE_ABORT=1`。

同理，判据必须**高精度低召回**：宁可漏报，也不能把正常长任务误判成跑偏 ——
误报会让用户不再相信这个提示（狼来了），功能等于失效。
`test/stopjudge.test.js` 的 14 例里，多数在验证"**不该报的都不能报**"。

### 3.4 接线

- `lib/routes/chat.js`：`newStats()` 里建裁判 → `pollMessages()` 先喂裁判 →
  跃迁以独立 `judge` 事件下发（**不用 notice**，前端要按级别渲染）→
  `finalizeRun` 的 `done` 事件附带最终结论。
- `stats.abort` 仅在 `HERMES_JUDGE_ABORT=1` 时接入（gateway 走 `controller.abort()`）。
- 前端：`public/app.js` 收到 `judge` 事件 → `addNote('⚖️ ' + obj.message, level==='hard' ? 'err' : 'warn')`。

### 3.5 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `HERMES_JUDGE_REPEAT_LIMIT` | 3 | D1 重复次数阈值 |
| `HERMES_JUDGE_DUP_RESULT_LIMIT` | 2 | D2 同结果次数阈值 |
| `HERMES_JUDGE_CALL_BUDGET` | 40 | D3 单 run 工具调用上限 |
| `HERMES_JUDGE_ABORT` | 未设 | 设 `1` 才允许裁判中断 run |
| `HERMES_CHECKPOINT_BASE` | `~/.hermes/checkpoints` | 影子库位置（测试指向临时目录） |
| `HERMES_CHECKPOINT_MAX_SNAPSHOTS` | 20 | 单项目张数上限 |
| `HERMES_CHECKPOINT_MAX_FILE_MB` | 10 | 单文件大小上限 |

### 3.6 与审计推荐方案的差异（诚实记录）

`docs/PROJECT-AUDIT-2026-09-12.md` 的 P1-3 推荐的是**LLM 冷裁判**：
run 结束前用同模型只读对话、无工具，判 `{ok | impossible | reason}`。

本轮**没有**实现冷裁判，改用了上表的确定性判据。理由：

- 本地 4B 模型自评不可靠，冷裁判本身可能同样乐观（审计自己也列了这条弊）；
- 每次 run 多几秒到几十秒 —— 而首字延迟 45s 已是当前最大痛点；
- 确定性判据**零额外延迟、零额外算力、可单测**，且能覆盖已复现的两类跑偏。

冷裁判仍是一个**未关闭的选项**：若要补，应放在 `HERMES_JUDGE_ABORT` 之外、
作为独立的"复盘"入口（事后判，不阻塞当下）。

---

## 四、判据 / 自测

```bash
hermes checkpoints status                    # live？sizeBytes / projects
curl -H "Authorization: Bearer $(cat ~/.hermes/ui_token)" \
     http://127.0.0.1:4173/api/checkpoints   # Node 侧视角
node --test test/checkpoints.test.js         # 14 例（跑在临时库上）
node --test test/stopjudge.test.js           # 14 例（多数在验"不该报的不报"）
npm run ui                                   # L11 层：面板能开 / 列表 / 两栏 / 按钮齐备
npm run health                               # §10 检查点与工作目录不变量（3 条）
```

> ⚠️ **配置真源在仓库外**：`checkpoints.*` 与 `terminal.cwd` 写在 `~/.hermes/config.yaml`，
> **不在 git 里**（该文件含 gateway key，本身也不该入库）。所以这两个修复**换机器重装不会自动复现**。
> 当前的防漂移手段是 `npm run health` §10 的三条断言（值被改回去会红），
> 以及 hermes 侧 `state-snapshots` 快照（覆盖 `~/.hermes/config.yaml`）。
> 若要把「重装即可复现」做实，应在 `setup.sh` 里加一步**幂等的配置块补写**——尚未做。

---

## 五、已知边界（未做，非遗漏）

| 边界 | 说明 |
|---|---|
| 只回退**文件**，不回退**对话** | 回退检查点不动 state.db 的消息历史，两件事别混淆 |
| 单文件回退到"当时不存在" | 语义是**删除**该文件（hermes 在此抛 pathspec 错，是它的缺陷不是规范），仍受单文件大小上限保护 |
| 无自动快照前的时间旅行 | 快照由 agent 写文件触发；纯对话轮次不产生检查点 |
| LLM 冷裁判 | 见 §3.6，未做，记录了理由 |
| `curator adopt` | 仍在待办（agent-created=0 时零作用） |
