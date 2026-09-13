'use strict';
/* =============================================================================
 * test/skills-gate.test.js —— lib/skills.js 的「引擎对齐」回归测试
 *
 * 覆盖两件事（均对齐引擎 agent/skill_utils.py 的行为）：
 *   1. 门控镜像：config.yaml 的 skills.disabled / platform_disabled.<平台> + frontmatter platforms 硬门控
 *   2. 递归扫描：技能按分类子目录组织（apple/imessage/…），必须递归——此前只扫一层漏 64%
 *
 * 跑法：  npm test
 *
 * Fixture 来源约定：
 *   - [真实] = 从本机 / 实际文件抄下的原文
 *   - [合成] = 本机当前 0 个禁用技能、0 个平台不符技能，故按已知 YAML 格式构造。
 *
 * ⚠️ 必须在 require('../lib/skills') 之前改 HOME —— lib/config.js 在 require 期
 *    就用 HOME 解析 CONFIG_YAML/SKILLS_DIR。node --test 每个文件独立进程，改 HOME 安全。
 * ========================================================================== */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-skill-gate-'));
process.env.HOME = HOME;
const H = path.join(HOME, '.hermes');

// rel 可含子目录（如 'apple/imessage'）；fmName 是 SKILL.md frontmatter 的 name。
function mkAt(rel, fmName, extra = '') {
  const d = path.join(H, 'skills', rel);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'),
    `---\nname: ${fmName}\ndescription: test ${fmName}\n${extra}---\nBody\n`);
}

fs.mkdirSync(path.join(H, 'skills'), { recursive: true });
mkAt('alpha', 'alpha');                                    // 顶层，正常
mkAt('beta', 'beta');                                      // 顶层，被 config 禁用
mkAt('gamma', 'gamma');                                    // 顶层，被 platform_disabled.api_server 禁用
mkAt('linux-only', 'linux-only', 'platforms: [linux]\n');  // 顶层，platforms 硬门控
mkAt('apple/imessage', 'imessage');                        // 嵌套：分类子目录
mkAt('apple/notes', 'apple-notes');                        // 嵌套：分类子目录
mkAt('alpha/scripts/fake', 'fake-in-support');             // 技能包内支撑目录 → 应被剪掉

// [合成] 覆盖三种写法：块式 disabled、分平台 platform_disabled.api_server、
// 以及干扰项 platform_disabled.cli（平台键固定 api_server，cli 分组不应影响我们）。
fs.writeFileSync(path.join(H, 'config.yaml'), [
  '# comment line',
  'skills:',
  '  preload:',
  '    - alpha',
  '  disabled:',
  '    - beta',
  '  platform_disabled:',
  '    api_server:',
  '      - gamma',
  '    cli:',
  '      - alpha',
  'model:',
  '  default: x',
  ''].join('\n'));

const S = require('../lib/skills');

describe('readDisabledSkillNames（引擎禁用名单镜像）', () => {
  test('读块式 disabled ∪ platform_disabled.api_server，忽略 cli 分组', () => {
    assert.deepEqual([...S.readDisabledSkillNames()].sort(), ['beta', 'gamma']);
  });

  test('配置文件缺失时降级为空集（不抛错）', () => {
    const bak = path.join(H, 'config.yaml.bak');
    fs.renameSync(path.join(H, 'config.yaml'), bak);
    try { assert.deepEqual([...S.readDisabledSkillNames()], []); }
    finally { fs.renameSync(bak, path.join(H, 'config.yaml')); }
  });
});

describe('scanLocalSkills —— 递归扫描', () => {
  test('嵌套在分类子目录里的技能能被发现（此前只扫一层会漏）', () => {
    const names = S.scanLocalSkills().map(s => s.name);
    assert.ok(names.includes('imessage'), 'apple/imessage 应被发现');
    assert.ok(names.includes('apple-notes'), 'apple/notes 应被发现');
  });

  test('分类由父路径推导（apple/imessage → "apple"；顶层 → ""）', () => {
    const items = S.scanLocalSkills();
    assert.equal(items.find(s => s.name === 'imessage').category, 'apple');
    assert.equal(items.find(s => s.name === 'alpha').category, '');
  });

  test('技能包内的支撑目录（scripts/）不算独立技能', () => {
    assert.ok(!S.scanLocalSkills().some(s => s.name === 'fake-in-support'));
  });
});

describe('scanLocalSkills —— 门控', () => {
  test('禁用名单 + platforms 硬门控 → 打 disabled 标记，但仍全部列出', () => {
    const items = S.scanLocalSkills();
    assert.deepEqual(items.filter(i => i.disabled).map(i => i.name).sort(),
      ['beta', 'gamma', 'linux-only']);
    assert.equal(items.find(i => i.name === 'beta').status, 'disabled');
    assert.equal(items.find(i => i.name === 'alpha').status, 'enabled');
  });

  test('仅出现在 cli 分平台禁用的技能不受影响（平台键固定 api_server）', () => {
    assert.ok(!S.scanLocalSkills().find(i => i.name === 'alpha').disabled);
  });
});

after(() => { fs.rmSync(HOME, { recursive: true, force: true }); });
