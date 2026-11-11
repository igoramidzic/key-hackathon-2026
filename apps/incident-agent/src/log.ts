/** Tiny leveled console logger. Colors only on a TTY. */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  magenta: paint(35),
  cyan: paint(36),
};

let threshold: Level = 'info';
export function setLogLevel(level: Level): void {
  threshold = level;
}

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (ORDER[level] < ORDER[threshold]) return;
  const time = new Date().toISOString().slice(11, 19);
  const tag =
    level === 'error'
      ? color.red('ERR')
      : level === 'warn'
        ? color.yellow('WRN')
        : level === 'debug'
          ? color.dim('DBG')
          : color.blue('INF');
  const line = `${color.dim(time)} ${tag} ${color.cyan(scope.padEnd(10))} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra instanceof Error ? extra.message : extra);
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, x) => emit('debug', scope, m, x),
    info: (m, x) => emit('info', scope, m, x),
    warn: (m, x) => emit('warn', scope, m, x),
    error: (m, x) => emit('error', scope, m, x),
  };
}

/** A logger that drops everything (tests). */
export const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
