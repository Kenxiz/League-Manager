import { AppError, toUserMessage } from '../utils/errors.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1MB body limit

export class Router {
  constructor({ apiKey = null, logger = null } = {}) {
    this.apiKey = apiKey;
    this.logger = logger;
    this.routes = []; // { method, pattern, paramNames, handler }
  }

  add(method, path, handler) {
    const paramNames = [];
    const regexPath = path.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    const pattern = new RegExp(`^${regexPath}$`);
    this.routes.push({ method: method.toUpperCase(), pattern, paramNames, handler });
  }

  get(path, handler) { this.add('GET', path, handler); }
  post(path, handler) { this.add('POST', path, handler); }
  put(path, handler) { this.add('PUT', path, handler); }
  patch(path, handler) { this.add('PATCH', path, handler); }
  delete(path, handler) { this.add('DELETE', path, handler); }

  async handle(req, res) {
    // 1. Universal CORS headers for web dashboards
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Helper: JSON response
    res.json = (data, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: true, data }));
    };

    // Helper: Error response
    const sendError = (err, status = 500) => {
      const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
      const message = toUserMessage(err);
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: false, error: { code, message, details: err.details } }));
    };

    try {
      // 2. Authentication check if API key is configured
      if (this.apiKey) {
        const auth = req.headers.authorization;
        const providedKey = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
        if (!providedKey || providedKey !== this.apiKey) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key.' } }));
          return;
        }
      }

      // 3. Parse URL & query
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());

      // 4. Find matching route
      const method = req.method.toUpperCase();
      let matched = null;
      let params = {};

      for (const r of this.routes) {
        if (r.method !== method) continue;
        const match = pathname.match(r.pattern);
        if (match) {
          matched = r;
          r.paramNames.forEach((name, i) => {
            params[name] = decodeURIComponent(match[i + 1]);
          });
          break;
        }
      }

      if (!matched) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: `Route ${method} ${pathname} not found.` } }));
        return;
      }

      req.params = params;

      // 5. Parse JSON body for mutation requests
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        req.body = await this.#parseBody(req);
      } else {
        req.body = {};
      }

      // 6. Execute route handler
      await matched.handler(req, res);
    } catch (err) {
      if (err instanceof AppError) {
        const statusMap = {
          NOT_FOUND: 404,
          CONFLICT: 409,
          VALIDATION: 400,
          FORBIDDEN: 403,
          RATE_LIMITED: 429,
          EXTERNAL: 502,
        };
        sendError(err, statusMap[err.code] || 400);
      } else {
        this.logger?.error({ err, path: req.url }, 'API request failed');
        sendError(err, 500);
      }
    }
  }

  async #parseBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > MAX_BODY_BYTES) {
          req.destroy();
          reject(new AppError('Request payload too large.', { code: 'PAYLOAD_TOO_LARGE' }));
        }
      });
      req.on('end', () => {
        if (!data.trim()) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new AppError('Malformed JSON body.', { code: 'VALIDATION' }));
        }
      });
      req.on('error', reject);
    });
  }
}
