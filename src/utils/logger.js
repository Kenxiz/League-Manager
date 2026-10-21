const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEYS = /token|secret|password|authorization|api[-_]?key/i;
// Discord bot tokens: <base64 id>.<6 char ts>.<27+ char hmac>
const TOKEN_PATTERN = /[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g;

/** Recursively masks secret-looking keys and token-shaped strings. */
export function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') return value.replace(TOKEN_PATTERN, '[REDACTED]');
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message, depth + 1),
      code: value.code,
      stack: redact(value.stack, depth + 1),
      cause: value.cause ? redact(value.cause, depth + 1) : undefined,
    };
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * Tiny structured logger. JSON lines in production, readable lines otherwise.
 * `logger.child({ guild })` adds bound context to every line.
 */
export function createLogger({ level = 'info', pretty = false, stream = process.stdout, bindings = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (lvl, msgOrObj, maybeMsg) => {
    if (LEVELS[lvl] < threshold) return;
    let msg = msgOrObj;
    let data = {};
    if (typeof msgOrObj !== 'string') {
      data = msgOrObj instanceof Error ? { err: msgOrObj } : msgOrObj ?? {};
      msg = maybeMsg ?? (data.err?.message ?? '');
    }
    const record = redact({ level: lvl, time: new Date().toISOString(), ...bindings, ...data, msg });
    if (pretty) {
      const { level: l, time, msg: m, ...rest } = record;
      const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest, (k, v) => (k === 'stack' ? undefined : v)) : '';
      const line = `${time.slice(11, 19)} ${l.toUpperCase().padEnd(5)} ${m}${extra}`;
      const stack = record.err?.stack ? `\n${record.err.stack}` : '';
      stream.write(line + stack + '\n');
    } else {
      stream.write(JSON.stringify(record) + '\n');
    }
  };

  return {
    debug: (a, b) => write('debug', a, b),
    info: (a, b) => write('info', a, b),
    warn: (a, b) => write('warn', a, b),
    error: (a, b) => write('error', a, b),
    child: (extra) => createLogger({ level, pretty, stream, bindings: { ...bindings, ...extra } }),
  };
}

/** Logger that discards everything (tests). */
export const silentLogger = createLogger({ level: 'error', stream: { write() {} } });
