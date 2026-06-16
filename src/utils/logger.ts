import chalk from 'chalk';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private level: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.level = level;
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
      console.log(chalk.gray(`[DEBUG] ${msg}`));
    }
  }

  info(msg: string): void {
    if (this.shouldLog('info')) {
      console.log(chalk.blue(`[INFO] ${msg}`));
    }
  }

  warn(msg: string): void {
    if (this.shouldLog('warn')) {
      console.warn(chalk.yellow(`[WARN] ${msg}`));
    }
  }

  error(msg: string): void {
    if (this.shouldLog('error')) {
      console.error(chalk.red(`[ERROR] ${msg}`));
    }
  }

  success(msg: string): void {
    console.log(chalk.green(`[SUCCESS] ${msg}`));
  }
}

export const logger = new Logger();
