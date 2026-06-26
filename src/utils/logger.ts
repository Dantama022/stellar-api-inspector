import chalk from 'chalk';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private level: LogLevel = 'info';
  private jsonMode = false;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Enable JSON mode. When active, all log output is redirected to stderr
   * so that stdout remains a clean JSON stream for consumers.
   */
  setJsonMode(enabled: boolean): void {
    this.jsonMode = enabled;
  }

  isJsonMode(): boolean {
    return this.jsonMode;
  }

  private shouldLog(msgLevel: LogLevel): boolean {
    const levels: Record<LogLevel, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };
    return levels[msgLevel] >= levels[this.level];
  }

  debug(msg: string): void {
    if (this.shouldLog('debug')) {
      const formatted = chalk.gray(`[DEBUG] ${msg}`);
      if (this.jsonMode) {
        process.stderr.write(formatted + '\n');
      } else {
        process.stdout.write(formatted + '\n');
      }
    }
  }

  info(msg: string): void {
    if (this.shouldLog('info')) {
      const formatted = chalk.blue(`[INFO] ${msg}`);
      if (this.jsonMode) {
        process.stderr.write(formatted + '\n');
      } else {
        process.stdout.write(formatted + '\n');
      }
    }
  }

  warn(msg: string): void {
    if (this.shouldLog('warn')) {
      const formatted = chalk.yellow(`[WARN] ${msg}`);
      process.stderr.write(formatted + '\n');
    }
  }

  error(msg: string): void {
    if (this.shouldLog('error')) {
      const formatted = chalk.red(`[ERROR] ${msg}`);
      process.stderr.write(formatted + '\n');
    }
  }

  success(msg: string): void {
    const formatted = chalk.green(`[SUCCESS] ${msg}`);
    if (this.jsonMode) {
      process.stderr.write(formatted + '\n');
    } else {
      process.stdout.write(formatted + '\n');
    }
  }
}

export const logger = new Logger();
