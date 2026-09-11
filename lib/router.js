'use strict';
/*
 * 极简路由表（P1-3 第二步）
 *
 * 硬约束：**必须保持 server.js 原有的匹配语义** —— 顺序遍历、首个命中即处理、
 * 前缀匹配（而非精确匹配）。所以这里不引入路径分隔符切分 / 参数解析，
 * 避免改变既有行为（例如 /api/health?x=1 仍须命中 '/api/health'）。
 *
 * matcher 支持三种形态：
 *   - 字符串：req.url.startsWith(matcher)
 *   - 正则  ：matcher.test(req.url)
 *   - 函数  ：matcher(req) 返回真值
 *
 * 为什么不直接用 express/find-my-way：项目零第三方依赖是硬约束（local-first），
 * 且引入精确匹配路由会静默改变行为（原代码靠顺序 + 前缀规避了歧义）。
 */

function createRouter(name) {
  const routes = [];

  return {
    name,

    add(method, matcher, handler) {
      routes.push({ method, matcher, handler });
      return this;
    },

    /* 返回 true = 已处理（handler 已负责写出响应）。
     * 返回 false = 未命中，调用方继续（静态文件 / 认证闸门 / 404）。 */
    async dispatch(req, res, ctx) {
      for (const r of routes) {
        if (r.method !== '*' && r.method !== req.method) continue;
        const m = r.matcher;
        const hit = typeof m === 'string' ? req.url.startsWith(m)
          : (m instanceof RegExp) ? m.test(req.url)
            : m(req);
        if (!hit) continue;
        await r.handler(req, res, ctx);
        return true;
      }
      return false;
    },

    /* 登记表（顺序即匹配优先级），供 healthcheck / 文档核对 */
    list() {
      return routes.map(r => ({
        method: r.method,
        matcher: typeof r.matcher === 'string' ? r.matcher
          : (r.matcher instanceof RegExp) ? String(r.matcher)
            : '<fn>',
      }));
    },
  };
}

module.exports = { createRouter };
