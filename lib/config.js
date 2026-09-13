'use strict';
/* =============================================================================
 * lib/config.js —— 全局常量与路径（单一真源）
 *
 * 为什么集中：拆单体前这些散落在 server.js 的头部与中段（路径、模型名、限额、
 * 补丁锚点混在一起），改任意一项都得先通读 800 行。集中之后「有哪些可调项」
 * 一眼可见，也避免同名常量在多模块各写一份导致漂移（例如两处 HOME 不一致）。
 *
 * ⚠️ WORKSPACE 用 path.resolve(__dirname, '..') 而非 __dirname —— 本文件在 lib/
 *    下，__dirname 指向 lib，父目录才是工作区根。HERMES_WORKSPACE 仍可覆盖。
 * ⚠️ 本文件在 require 期就会执行 resolvePython()（探测文件系统，无副作用），
 *    但**不**读写任何业务状态。
 * ========================================================================== */

const path = require('path');
const os = require('os');
const { resolvePython, SESSION_ID_RE } = require('./parse');

const HOME = process.env.HOME || os.homedir();
const WORKSPACE = process.env.HERMES_WORKSPACE || path.resolve(__dirname, '..');

const PORT = process.env.PORT || 4173;
const HOST = process.env.HOST || '127.0.0.1';   // D4: 局域网访问设 HOST=0.0.0.0（token 认证已就位）

/* ---------- 路径 ---------- */
const PUBLIC_DIR = path.join(WORKSPACE, 'public');
const KB_SCRIPT = path.join(WORKSPACE, 'kb', 'kb.py');
// P2-9: Python 路径运行时解析（防"版本目录改名即腐烂"，同 node 的 22.22.2-2→-3 教训）
const KB_PYTHON = resolvePython(HOME);
const HERMES = `${HOME}/.hermes/venvs/hermes/bin/hermes`;
const DB_PATH = `${HOME}/.hermes/state.db`;
const SKILLS_DIR = `${HOME}/.hermes/skills`;
const TOKEN_FILE = `${HOME}/.hermes/ui_token`;
// 引擎配置真源：技能门控（skills.disabled / platform_disabled）等从这里读，
// 保证 UI 侧技能视图与引擎实际提供的一致（引擎在 agent/skill_utils.py 里按同一份配置过滤）。
const CONFIG_YAML = `${HOME}/.hermes/config.yaml`;
const CLOUD_FILE = `${HOME}/.hermes/cloud_providers.json`;
const SKILL_EMBED_FILE = `${HOME}/.hermes/.skill_embeddings.json`;
// KB 向量索引缓存（混合检索用；与技能索引同思路：按内容指纹失效，跨重启复用）
const KB_EMBED_FILE = `${HOME}/.hermes/.kb_embeddings.json`;
const MEMORY_DIR = `${HOME}/.hermes/memories`;
const MEMORY_FILE = `${MEMORY_DIR}/MEMORY.md`;
const USER_FILE = `${MEMORY_DIR}/USER.md`;
const UPLOADS_DIR = `${HOME}/.hermes/uploads`;
const UPLOAD_RETENTION_DAYS = 7;
// P3-12: 用量日志落盘（JSONL，一行一条）—— 内存环形缓冲重启即失，趋势对比需要长期数据。
// 覆盖方式：HERMES_USAGE_FILE（见 lib/usage.js 的 usageFile()，测试也走这个口子）。
const USAGE_FILE = `${HOME}/.hermes/usage.jsonl`;
// D2: launchd 的 StandardOutPath/StandardErrorPath 无内置轮转，崩溃循环可能写爆磁盘
const LOG_FILES = [
  `${HOME}/Library/Logs/hermes-ui.out.log`,
  `${HOME}/Library/Logs/hermes-ui.err.log`,
];

/* ---------- 知识库数据源（KB Integration：4174 serve.py 的能力已并入本服务） ---------- */
const KB_INBOX = path.join(WORKSPACE, '.workbuddy', 'kb_inbox.md');
const KB_DISTILLED = path.join(WORKSPACE, '.workbuddy', 'kb_distilled.md');
const KB_MEM_PROJ = path.join(WORKSPACE, '.workbuddy', 'memory', 'MEMORY.md');
const KB_MEM_USER = path.join(HOME, '.workbuddy', 'MEMORY.md');

/* ---------- 服务端点 ---------- */
const OLLAMA = 'http://127.0.0.1:11434';

/* ---------- 模型 ---------- */
// 2026-09-10 换装 gemma4:e4b：一个多模态模型同时承担对话/工具/视觉/音频。
// 列表为「偏好序」，实际下拉在 /api/models 里与已装模型取交集（避免列出不存在的模型）。
// 注意：这里只放「确实装过」的模型。/api/tags 不可达时会直接回退到本列表，
// 列了不存在的模型 → 下拉里出现选了就报错的幽灵项（qwen2.5:7b / hermes-local 已删除，勿再加回）。
const LOCAL_MODELS = ['hermes-local-gemma4', 'gemma4:e4b'];
const DEFAULT_MODEL = 'hermes-local-gemma4';
const VISION_MODEL = DEFAULT_MODEL;   // 视觉/音频与对话同模型，杜绝 16G 下的换载开销
const EMBED_MODEL = 'bge-m3';         // 技能语义检索用的本地嵌入模型
// 对话模式（侧栏「对话/工作」分段开关的「对话」侧）：轻量模型 + 瘦 prompt，绕过引擎直连
// Ollama，解决"日常闲聊也要扛 1.5 万 token prefill"的首字延迟。与工作模型双驻留（约 3.4G + 3.2G）。
const CHAT_MODEL = 'hermes-chat-8b';
const CHAT_HISTORY_MAX = 20;          // 对话模式每次带给模型的最近消息条数（8k ctx 内）
const CHAT_HISTORY_BUDGET = 6000;     // 历史窗口字符预算：超预算丢最旧消息，防 8k ctx 被长历史撑爆

/* ---------- 限额与周期 ---------- */
const BODY_LIMIT = 100 * 1024;   // 100 KB（多模态/上传路由各自放宽）
const PROMPT_LIMIT = 8000;       // 字符
const POLL_MS = 150;             // DB / stream 文件轮询周期
const KEEP_ALIVE = '2h';         // Ollama 模型驻留时长

/* ---------- 领域常量 ----------
 * SESSION_ID_RE 的真源在 lib/parse.js（解析层要用，而 config 反向依赖 parse，
 * 故不能反过来在此定义，否则成循环依赖），此处仅**转出**供路由层校验使用。
 * ⚠️ 切勿在此再写一份 —— 2026-09-12 正是因为两处各写一份，gateway 切换后只改一处，
 *    导致 /api/session/{rename,delete,export} 与 /api/workspace/assign
 *    对全部 gateway 会话（api_ 形态）一律返回 400。 */

module.exports = {
  HOME, WORKSPACE, PORT, HOST,
  PUBLIC_DIR, KB_SCRIPT, KB_PYTHON, HERMES, DB_PATH, SKILLS_DIR,
  TOKEN_FILE, CLOUD_FILE, SKILL_EMBED_FILE, KB_EMBED_FILE, CONFIG_YAML,
  MEMORY_DIR, MEMORY_FILE, USER_FILE,
  UPLOADS_DIR, UPLOAD_RETENTION_DAYS, USAGE_FILE, LOG_FILES,
  KB_INBOX, KB_DISTILLED, KB_MEM_PROJ, KB_MEM_USER,
  OLLAMA,
  LOCAL_MODELS, DEFAULT_MODEL, VISION_MODEL, EMBED_MODEL, CHAT_MODEL, CHAT_HISTORY_MAX, CHAT_HISTORY_BUDGET,
  BODY_LIMIT, PROMPT_LIMIT, POLL_MS, KEEP_ALIVE,
  SESSION_ID_RE,
};
