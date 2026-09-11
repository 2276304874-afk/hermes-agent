# 赫尔墨斯特工 · 长期项目记忆

## 架构与服务
- UI 服务:`server.js`(无第三方依赖,node 22)由 launchd `com.hermes-agent.ui` 托管,端口 4173,绑 127.0.0.1(HOST env 可改 0.0.0.0 开局域网)。真源 plist:工作区 `launchd/com.hermes-agent.ui.plist`;部署/自检:`bash setup.sh`。
- **launchd 装/管权限边界(2026-09-11 定型)**:`bootstrap`/`load` 在我的 shell 里必 EIO 5(非 GUI 会话),**必须用户在 Terminal.app 跑一次 `setup.sh`**;但守护一旦注册,**`launchctl kickstart -k gui/$(id -u)/com.hermes-agent.ui` 在我这边可用** → 之后改 server.js 我自己就能重启,不用麻烦用户。
- 启动链:plist → `/bin/bash run.sh` → `run.sh` 运行期解析 node(优先 `~/.workbuddy/binaries/node/versions/*` 最高版)→ `exec node server.js`。**禁再硬编码 node 版本路径**(22.22.2-2→-3 曾静默失效)。
- 认证:Bearer token 在 `~/.hermes/ui_token`(0600,重启不变)。
- 引擎:Hermes CLI(`~/.hermes/venvs/hermes/bin/hermes`)。调用必 `env -u PYTHONPATH`(WorkBuddy sitecustomize 劫持 mkdir);本地请求必 `NO_PROXY=127.0.0.1,localhost`。
- 进度:server.js 每 150ms 轮询 `~/.hermes/state.db` messages 表 + oneshot.py 流式补丁(启动自愈)。静态文件实时读盘,改 HTML 即时生效;改 server.js 需 kickstart。

## 模型与 Ollama
- **主模型(2026-09-10 起):`hermes-local-gemma4`**(base `gemma4:e4b`,PLE 稀疏激活,9.6GB 盘 / ~3.3GB 驻留,128K ctx,原生 tools+vision+audio)。**一个模型同时扛对话/工具/视觉/音频**,已不再需要 llava 换载。
- Ollama.app(GUI)托管,max_loaded_models 默认 1。
- ⚠️ **绝不给工具型 agent 关 CoT**:在 Hermes `/v1` 上 `think:false` 被忽略,只有 `reasoning_effort:"none"` 生效;而关掉后小模型会**只说不做**(嘴上"已记录",`messages.tool_calls` 实为空)→ 记忆功能假死。曾踩过并回滚。
- Vision:`/api/vision`(llava:7b 为旧路径),请求级 keep_alive 30m。llava 冷加载/换载 12s~4min 波动(page cache 决定)。
- 16G 内存:多模型同驻被 macOS 权限挡(`launchctl setenv` Not privileged);GUI Ollama 菜单设置或 root 可解。

## 工程纪律(血泪教训)
- **永不并行 Edit 同一文件**(竞态丢更新)。
- **本机 Bash grep `a\|b` 交替模式不可信**(假阴性),用 Grep 工具或 python。
- **判断"服务没起来/未注册"必须用 `launchctl print gui/$(id -u)/<label>` 核验,不能用 `launchctl list`** —— 后者在我的 shell 里恒返回 0 行,曾据此误报"守护未注册"。域级导出 `launchctl print gui/$(id -u)` 也可看到 `pid -状态 label` 行。
- **ps / lsof 在我的 shell 里可能看不到用户 GUI 会话的进程**(`ps` 报 operation not permitted);判断进程存活改用 `lsof -nP -iTCP:4173 -sTCP:LISTEN` + `/api/health` 的 uptimeSec 递增。
- **UI 长流程测试后 server.js 会被孤儿 SSE/hermes 子进程弄脏**(curl 也挂)→ kickstart 即愈。
- **测试期间不并发 curl 其他模型**(单驻留下互抢换载,互相拖死)。
- **判"功能缺失"前先确认跑的是新代码**:旧实例常占着端口,新代码未重启就测会得假阴性。用 `/api/*` 新路由 404/unauthorized 反推。
- **plist 里禁止在 `<array>`/`<dict>` 内部写 XML 注释**:`plutil` 能过但 launchd 报 `EX_CONFIG 78`。注释只能放文件头。
- all./usr/bin 与托管 python 均支持 sqlite FTS5 trigram,故 KB 解释器可安全回退;但仍应动态解析而非硬编码版本目录(见 `resolvePython()` / `kb/sync.sh`)。

## 知识库(KB)集成
- 统一入口=主服务 4173:`GET /kb`(托管 `kb/viewer.html`)、`GET /api/kb/list?cat=inbox|distilled|memory|all`(**返回纯数组**)、`GET /api/kb/search?q=`(复用 recallHits)、`GET /api/kb/status`。均为公开只读(仅 127.0.0.1)。
- 数据源:`kb_inbox.md` / `kb_distilled.md` / `~/.hermes/memories/MEMORY.md`(实测 19/23/1 = 43 条)。
- 智能体主动调用路径:`~/.hermes/skills/kb-query/SKILL.md`(对话中需要历史经验时调 `kb.py recall` 或 `curl /api/kb/search`)。
- `kb/serve.py`(4174)已标弃用 → 降级为离线兜底;无 plist/cron/代码引用它。设计文档:`KB_INTEGRATION.md`。

## 路线图现状(2026-09-11)
- ✅ launchd 守护已装成功(state=running,RunAtLoad+KeepAlive);kickstart 可自重启。
- ✅ KB 集成落地(viewer.html 同源化 + `/api/kb/*` + 顶栏入口 + kb-query 技能)。
- ✅ P2-7 残留脚本归档到 `archive/one-off-fix-scripts-20260911/`;
- ✅ P2-8 serve.py 标弃用;P2-9 `resolvePython()` + sync.sh 动态解析 + `warnIfParseEmpty` 格式保鲜告警。
- ⏳ 待办:P0-2 崩溃根因(等复现)、P1-3 拆单体、P1-6 补测试、P2-10 KB 认证决策、**项目非 git 仓库(建议 git init)**。
- 改进清单见 `IMPROVEMENT_PLAN.md`;N8 等项目详情见 `UPGRADE_ROADMAP.md` 与 daily logs。
