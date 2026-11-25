/**
 * Минимальный HTTP-слой на встроенном модуле node:http.
 * Заменяет express, чтобы приложение не требовало node_modules:
 * одна папка + Node.js — и всё работает.
 *
 * Поддерживаемое подмножество express-API:
 *   app.use([prefix], fn)      app.get/post/patch/put/delete(path, ...fn)
 *   req.params / req.query / req.body / req.path / req.user
 *   res.status(c).json(x)      res.send(str)   res.sendFile(p)   res.download(p, name)
 *   res.redirect(to)           res.setHeader(...)
 *   serveStatic(dir)           монтирование подприложений через use
 *
 * Из коробки: gzip для текстовых ответов, ETag/304 для статики, заголовки безопасности.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml)|image\/svg)/;
const GZIP_MIN = 1024;

/** Заголовки безопасности + базовые оптимизации. */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-DNS-Prefetch-Control': 'off',
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** '/orders/:id/status' -> { rx, keys } */
function compile(pattern, prefixMatch = false) {
  const keys = [];
  const parts = String(pattern).split('/').filter(Boolean);
  if (!parts.length) {
    // '/' как префикс означает «всё», как маршрут — только корень
    return { rx: new RegExp(prefixMatch ? '.*' : '^\\/$'), keys };
  }
  let src = '';
  for (const p of parts) {
    src += '\\/';
    if (p.startsWith(':')) {
      keys.push(p.slice(1));
      src += '([^\\/]+)';
    } else {
      src += escapeRe(p);
    }
  }
  const tail = prefixMatch ? '(?:\\/.*)?' : '\\/?';
  return { rx: new RegExp('^' + src + tail + '$'), keys };
}

function decode(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}

const acceptsGzip = (req) => /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));

/** Сжимает ответ, если это того стоит. */
function finish(req, res, buf, contentType, { cacheControl } = {}) {
  res.setHeader('Content-Type', contentType);
  if (cacheControl) res.setHeader('Cache-Control', cacheControl);
  if (res.getHeader('Vary') === undefined) res.setHeader('Vary', 'Accept-Encoding');

  const canZip = acceptsGzip(req) && COMPRESSIBLE.test(contentType) && buf.length >= GZIP_MIN;
  if (canZip) {
    const zipped = zlib.gzipSync(buf, { level: 6 });
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', zipped.length);
    res.end(zipped);
    return res;
  }
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
  return res;
}

/** Расширяем объекты req/res удобными методами. */
function decorate(req, res) {
  const u = new URL(req.url, 'http://localhost');
  req.path = decode(u.pathname);
  req.query = Object.fromEntries(u.searchParams.entries());
  req.params = {};
  req.body = {};

  res.statusCode = res.statusCode || 200;
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => {
    const body = Buffer.from(JSON.stringify(data), 'utf8');
    return finish(req, res, body, 'application/json; charset=utf-8', { cacheControl: 'no-store' });
  };
  res.send = (data) => {
    if (data == null) { res.end(); return res; }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const type = res.getHeader('Content-Type') || 'text/html; charset=utf-8';
    return finish(req, res, buf, type);
  };
  res.sendFile = (file, opts = {}) => {
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const cache = opts.cacheControl !== undefined ? opts.cacheControl : defaultCache(file);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Файл не найден');
        return;
      }
      finish(req, res, buf, type, { cacheControl: cache });
    });
    return res;
  };
  /** Отдача файла как вложения (бэкап БД). */
  res.download = (file, name) => {
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Файл не найден');
        return;
      }
      res.setHeader('Content-Disposition',
        `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'no-store');
      res.end(buf);
    });
    return res;
  };
  res.redirect = (to) => {
    res.statusCode = 302;
    res.setHeader('Location', to);
    res.end();
    return res;
  };
  return { req, res };
}

/** HTML-страницы и скрипты не кэшируем, картинки и шрифты — на год. */
function defaultCache(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'no-cache';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf'].includes(ext)) {
    return 'public, max-age=604800';
  }
  return 'no-cache';
}

function createApp() {
  const layers = [];

  const api = {
    layers,

    use(arg1, arg2) {
      if (typeof arg1 === 'function') {
        layers.push({ kind: 'use', prefix: '', rx: /.*/, keys: [], handlers: [arg1] });
      } else {
        const { rx, keys } = compile(arg1 || '', true);
        layers.push({
          kind: 'use', prefix: arg1 || '', rx, keys,
          handlers: Array.isArray(arg2) ? arg2 : [arg2],
        });
      }
      return api;
    },

    handle(req, res, done) {
      let i = 0;
      const layersList = layers;

      const next = (err) => {
        if (err) return done ? done(err) : fail(req, res, err);
        const layer = layersList[i++];
        if (!layer) return done ? done() : undefined;

        const m = layer.rx.exec(req.path);
        if (!m) return next();
        // ВАЖНО: метод обязателен — иначе POST /supplies попадёт в GET /supplies
        if (layer.kind === 'route' && layer.method && layer.method !== req.method) return next();

        if (layer.keys && layer.keys.length) {
          layer.keys.forEach((k, idx) => { req.params[k] = decode(m[idx + 1] || ''); });
        }

        let j = 0;
        const hs = layer.handlers;
        const step = (e2) => {
          if (e2) return next(e2);
          const h = hs[j++];
          if (!h) return next();
          try {
            const out = h(req, res, step);
            if (out && typeof out.then === 'function') out.then(() => {}, step);
          } catch (e3) { step(e3); }
        };
        step();
      };

      next();
    },
  };

  ['get', 'post', 'patch', 'put', 'delete', 'head'].forEach((method) => {
    api[method] = (patterns, ...handlers) => {
      const list = Array.isArray(patterns) ? patterns : [patterns];
      for (const p of list) {
        const { rx, keys } = compile(p, false);
        layers.push({ kind: 'route', method: method.toUpperCase(), rx, keys, handlers });
      }
      return api;
    };
  });
  api.del = api.delete;

  return api;
}

function fail(req, res, err) {
  if (res.writableEnded) return;
  const status = err && err.status ? err.status : 500;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: (err && err.message) || 'Ошибка сервера' }));
}

/** Парсинг JSON-тела запроса (аналог express.json()). */
function jsonBody(limitBytes = 2 * 1024 * 1024) {
  return (req, res, next) => {
    const ct = String(req.headers['content-type'] || '');
    if (!req.headers['content-length'] || !ct.includes('application/json')) return next();
    const len = Number(req.headers['content-length']);
    if (!Number.isFinite(len) || len > limitBytes) return next(Object.assign(new Error('Слишком большой запрос'), { status: 413 }));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return next();
      try {
        const parsed = JSON.parse(raw);
        req.body = parsed && typeof parsed === 'object' ? parsed : {};
        next();
      } catch (e) {
        next(Object.assign(new Error('Некорректный JSON'), { status: 400 }));
      }
    });
    req.on('error', next);
  };
}

/** Раздача статических файлов из каталога. */
function serveStatic(dir, opts = {}) {
  const root = path.resolve(dir);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel = decodeURIComponent(req.path).replace(/^\/+/, '');
    if (!rel) rel = opts.index === false ? '' : 'index.html';

    const full = path.resolve(root, rel);
    // защита от выхода за пределы каталога
    if (full !== root && !full.startsWith(root + path.sep)) return next();

    fs.stat(full, (err, st) => {
      if (err) return next();
      let file = full;
      if (st.isDirectory()) {
        if (opts.index === false) return next();
        file = path.join(full, 'index.html');
        try {
          if (!fs.statSync(file).isFile()) return next();
        } catch { return next(); }
      } else if (!st.isFile()) {
        return next();
      }
      // ETag по времени изменения и размеру: повторный запрос отдаётся как 304
      const tag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
      res.setHeader('ETag', tag);
      if (req.headers['if-none-match'] === tag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      res.sendFile(file, opts);
    });
  };
}

/** Красивая страница 404 в стиле интерфейса. */
function notFoundPage(pathname) {
  const safe = String(pathname || '').replace(/[<>&]/g, '');
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Страница не найдена — PCBuilder</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0B12;color:#EDEFF6;
       font:15px/1.6 "Inter","Segoe UI",system-ui,sans-serif;text-align:center;padding:24px}
  .box{max-width:520px}
  .code{font-size:82px;font-weight:800;letter-spacing:-.04em;
       background:linear-gradient(135deg,#8B5CF6,#22D3EE);-webkit-background-clip:text;background-clip:text;color:transparent}
  h1{font-size:22px;margin:8px 0}
  p{color:#9CA3AF;margin:0 0 22px}
  a.btn{display:inline-block;padding:11px 22px;border-radius:12px;text-decoration:none;font-weight:600;color:#fff;
       background:linear-gradient(135deg,#7C3AED,#6D28D9);box-shadow:0 10px 30px rgba(124,58,237,.35)}
  a.ghost{background:none;color:#9CA3AF;margin-left:10px}
  code{background:rgba(255,255,255,.07);padding:2px 8px;border-radius:6px;font-size:13px}
</style></head><body><div class="box">
<div class="code">404</div>
<h1>Такой страницы нет</h1>
<p>Адрес <code>${safe}</code> не найден. Возможно, ссылка устарела или в ней опечатка.</p>
<a class="btn" href="/">На главную</a><a class="btn ghost" href="/track">Отследить заказ</a>
</div></body></html>`;
}

/** Сборка сервера: приложение + цепочка middleware + обработчик ошибок. */
function createServer(app, { errorHandler } = {}) {
  const server = http.createServer((req, res) => {
    decorate(req, res);

    let i = 0;
    const next = (err) => {
      if (err) {
        if (errorHandler) return errorHandler(err, req, res, () => fail(req, res, err));
        return fail(req, res, err);
      }
      const layer = app.layers[i++];
      if (!layer) {
        // никто не ответил
        if (!res.writableEnded) {
          res.statusCode = 404;
          if (String(req.headers.accept || '').includes('application/json')) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'Метод не найден', path: req.path }));
          } else {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(notFoundPage(req.path));
          }
        }
        return;
      }

      // монтированное подприложение
      if (layer.kind === 'use' && layer.handlers.length === 1 && layer.handlers[0].layers) {
        const sub = layer.handlers[0];
        const prefix = layer.prefix || '';
        const savedPath = req.path;
        const savedUrl = req.url;
        if (prefix && prefix !== '/') {
          req.path = req.path.slice(prefix.length) || '/';
          req.url = req.url.slice(prefix.length) || '/';
        }
        return sub.handle(req, res, (e2) => {
          req.path = savedPath;
          req.url = savedUrl;
          next(e2);
        });
      }

      const m = layer.rx.exec(req.path);
      if (!m) return next();
      if (layer.kind === 'route' && layer.method !== req.method) return next();
      if (layer.keys && layer.keys.length) {
        layer.keys.forEach((k, idx) => { req.params[k] = decode(m[idx + 1] || ''); });
      }

      let j = 0;
      const hs = layer.handlers;
      const step = (e2) => {
        if (e2) return next(e2);
        const h = hs[j++];
        if (!h) return next();
        try {
          const out = h(req, res, step);
          if (out && typeof out.then === 'function') out.then(() => {}, step);
        } catch (e3) { step(e3); }
      };
      step();
    };

    next();
  });
  return server;
}

module.exports = { createApp, createServer, jsonBody, serveStatic, MIME, notFoundPage };