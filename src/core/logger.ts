/* eslint-disable no-console -- SDK logger'ı bilinçli olarak konsola yazar */
import type { LogLevel } from './types.js';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** Konsol logger; varsayılan `warn`. Gizli bilgi (token) hiçbir seviyede yazılmaz. */
export class Logger {
  constructor(
    private level: LogLevel = 'warn',
    private readonly prefix = '[HeroSignal]',
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  error(...args: unknown[]): void {
    if (ORDER[this.level] >= 1) console.error(this.prefix, ...args);
  }
  warn(...args: unknown[]): void {
    if (ORDER[this.level] >= 2) console.warn(this.prefix, ...args);
  }
  info(...args: unknown[]): void {
    if (ORDER[this.level] >= 3) console.info(this.prefix, ...args);
  }
  debug(...args: unknown[]): void {
    if (ORDER[this.level] >= 4) console.debug(this.prefix, ...args);
  }
}
