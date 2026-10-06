type Fields = Record<string, unknown>;

function serialize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? { message: value.message, stack: value.stack } : value;
  }
  return out;
}

function write(level: 'info' | 'warn' | 'error', msg: string, fields: Fields = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...serialize(fields) });
  (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
}

export const log = {
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};
