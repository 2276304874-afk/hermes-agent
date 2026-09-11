'use strict';
/* =============================================================================
 * lib/maintenance.js —— 启动期/周期性的自愈与清扫
 *
 * 两件事，都属于「不做也能跑，做了能防住慢性故障」：
 *   trimOversizedLogs  —— launchd 捕获的 stdout/stderr 无内置轮转，崩溃循环会写爆磁盘
 *   cleanStaleUploads  —— /api/upload 只进不出会慢慢吃磁盘（默认保留 7 天）
 *
 * 两者都吞异常：维护动作失败不该阻止服务启动。
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const { LOG_FILES, UPLOADS_DIR, UPLOAD_RETENTION_DAYS } = require('./config');

/* ---------- D2: 日志守护 ---------- */
function trimOversizedLogs() {
  try {
    for (const f of LOG_FILES) {
      if (!fs.existsSync(f)) continue;
      const st = fs.statSync(f);
      if (st.size > 10 * 1024 * 1024) {
        const fd = fs.openSync(f, 'r+');
        const tail = 1024 * 1024;
        const buf = Buffer.alloc(tail);
        fs.readSync(fd, buf, 0, tail, st.size - tail);
        fs.ftruncateSync(fd, tail);
        fs.writeSync(fd, buf, 0, tail, 0);
        fs.closeSync(fd);
        console.log(`[log] ${f} 超 10MB，已截断保留尾部 1MB`);
      }
    }
  } catch (e) { /* 日志守护失败不影响服务 */ }
}

/* ---------- B1: 上传文件生命周期 ---------- */
function cleanStaleUploads() {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return;
    const cutoff = Date.now() - UPLOAD_RETENTION_DAYS * 86400 * 1000;
    let removed = 0;
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const p = path.join(UPLOADS_DIR, f);
      try {
        if (fs.statSync(p).isFile() && fs.statSync(p).mtimeMs < cutoff) {
          fs.unlinkSync(p);
          removed++;
        }
      } catch { /* 单个文件失败跳过 */ }
    }
    if (removed) console.log(`[uploads] 清扫过期上传文件 ${removed} 个（>${UPLOAD_RETENTION_DAYS} 天）`);
  } catch (e) { /* 清扫失败不影响服务 */ }
}

/* 启动自检入口（顺序固定：日志截断 → 上传清扫 → 注册 24h 周期清扫） */
function runStartupMaintenance() {
  trimOversizedLogs();
  cleanStaleUploads();
  setInterval(cleanStaleUploads, 24 * 3600 * 1000);
}

module.exports = { trimOversizedLogs, cleanStaleUploads, runStartupMaintenance };
