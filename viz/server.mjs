/**
 * Castalia Web Console — 3D 可视化主界面 + 管理副界面(入口)
 *
 * 独立 Express 服务器。路由已拆分到 routes/*.js:
 *   - routes/graph.js     /api/graph /api/stats /api/status
 *   - routes/memory.js    /api/memory CRUD /move /toggle_important /update
 *   - routes/config.js    /api/config GET/POST
 *   - routes/reflect.js   /api/reflect/run /api/reflect/history
 *   - routes/aggregate.js /api/aggregate/* /api/manage/*
 *
 * 环境变量:
 *   WEB_PORT         默认 3345
 *   MEMORY_DB_DIR    默认 <项目根>/memory/(按项目分库)
 *   MEMORY_DB_PATH   旧单库路径(兼容模式)
 *   NODE_BIN         默认 node(PATH)
 */
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { PORT, DB_DIR } from './routes/lib.js';

import graphRouter from './routes/graph.js';
import memoryRouter from './routes/memory.js';
import configRouter from './routes/config.js';
import reflectRouter from './routes/reflect.js';
import aggregateRouter from './routes/aggregate.js';
import membersRouter from './routes/members.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));

// 所有写请求只接受本机同源:挡 DNS rebinding / 跨站 CSRF(2026-10-17)。
// 星图/管理 API 会软删/迁移记忆、改写 config,不能只靠"绑了 127.0.0.1"。
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const host = String(req.headers.host || '').toLowerCase();
  const hostname = host.startsWith('[') ? host.split(']')[0] + ']' : (host.includes(':') ? host.split(':')[0] : host);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
    return res.status(403).json({ ok: false, error: '仅允许本机访问' });
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      const ohost = new URL(origin).hostname;
      if (!['127.0.0.1', 'localhost', '::1'].includes(ohost)) {
        return res.status(403).json({ ok: false, error: '拒绝跨站请求' });
      }
    } catch { return res.status(403).json({ ok: false, error: '拒绝跨站请求' }); }
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    return res.status(403).json({ ok: false, error: '拒绝跨站请求' });
  }
  next();
});

// API 路由
app.use('/api', graphRouter);
app.use('/api', memoryRouter);
app.use('/api', configRouter);
app.use('/api', reflectRouter);
app.use('/api', aggregateRouter);
app.use('/api', membersRouter);

// ═══ AIRI 管理抽屉转发(/admin /memory → unified-proxy :5050)═══
// 管理抽屉的配置/反思/记忆管理接口由 unified-proxy 提供,这里做 HTTP 透传
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:5050';
app.use(['/admin', '/memory'], async (req, res) => {
  try {
    const url = PROXY_URL + req.originalUrl;
    const headers = { ...req.headers };
    delete headers.host;
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    if (!isGet) headers['content-type'] = req.headers['content-type'] || 'application/json';
    const body = isGet ? undefined : JSON.stringify(req.body || {});
    const upstream = await fetch(url, { method: req.method, headers, body });
    const text = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: `proxy 转发失败: ${e.message}` });
  }
});

// ═══ 静态服务 ═══
// 本地 3D 依赖(three.js / 3d-force-graph)——离线可用;文件名带版本号,升级即换名防缓存
app.use('/vendor', express.static(join(__dirname, 'public', 'vendor'), { maxAge: '1h' }));
// 前端自身的 CSS/JS(2026-09-19 从 index.html 内联样式/脚本抽出,便于维护;no-cache 由下面中间件统一加)
app.use('/assets', express.static(join(__dirname, 'public', 'assets'), { maxAge: 0, etag: false }));
for (const f of ['castalia-mark.png', 'castalia.png', 'favicon.png']) {
  app.get('/' + f, (_req, res) => res.sendFile(join(__dirname, 'public', f)));
}
// 拆分后的前端模块(普通 script,no-cache 防开发期缓存)
// 页面/API 不缓存
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-cache'); next(); });
/**
 * 页面输出。`?embed=1` 时插一层改色/去壳的样式和 `html.embed` 标记：
 * 被 AIRI 设置页的 iframe 嵌进来时用，独立开浏览器时完全不受影响。
 */
function sendPage(file, req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  let html = readFileSync(join(__dirname, 'public', file), 'utf-8');
  if (String(req.query.embed || '') === '1') {
    html = html.replace('</head>', '<link rel="stylesheet" href="/assets/embed.css?v=1"></head>');
  }
  res.send(html);
}
app.get('/', (req, res) => sendPage('index.html', req, res));
app.get('/aggregate.html', (req, res) => sendPage('aggregate.html', req, res));
app.get('/manage.html', (req, res) => sendPage('manage.html', req, res));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   Castalia Web Console                  ║
  ║   http://127.0.0.1:${PORT}                  ║
  ║   DB_DIR: ${DB_DIR}  ║
  ╚══════════════════════════════════════════╝
  `);
});
