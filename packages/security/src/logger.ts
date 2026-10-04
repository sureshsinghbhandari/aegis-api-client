import { redactObject, redactText } from './redaction';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
const ORDER: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: unknown;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export class ConsoleLogSink implements LogSink {
  write(record: LogRecord): void {
    const line = JSON.stringify(record);
    if (record.level === 'ERROR') console.error(line);
    else if (record.level === 'WARN') console.warn(line);
    else console.log(line);
  }
}

export class MemoryLogSink implements LogSink {
  readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
}

/** Structured logger. Every record passes through redaction before it reaches a sink. */
export class Logger {
  constructor(
    private readonly sinks: LogSink[],
    private level: LogLevel = 'INFO',
    private readonly scope = 'app',
    private readonly extraPatterns: () => readonly string[] = () => [],
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  child(scope: string): Logger {
    const child = new Logger(this.sinks, this.level, `${this.scope}.${scope}`, this.extraPatterns);
    return child;
  }

  private emit(level: LogLevel, msg: string, data?: unknown): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const patterns = this.extraPatterns();
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      msg: redactText(msg, [], patterns),
      data: data === undefined ? undefined : redactObject(serializeData(data), patterns),
    };
    for (const sink of this.sinks) {
      try {
        sink.write(record);
      } catch {
        /* a failing sink must never break the app */
      }
    }
  }

  debug(msg: string, data?: unknown): void {
    this.emit('DEBUG', msg, data);
  }
  info(msg: string, data?: unknown): void {
    this.emit('INFO', msg, data);
  }
  warn(msg: string, data?: unknown): void {
    this.emit('WARN', msg, data);
  }
  error(msg: string, data?: unknown): void {
    this.emit('ERROR', msg, data);
  }
}

function serializeData(data: unknown): unknown {
  if (data instanceof Error) {
    const code = (data as { code?: unknown }).code;
    return { name: data.name, message: redactText(data.message), code };
  }
  return data;
}
