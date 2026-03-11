/**
 * Shared Logger Module
 *
 * Unified logging interface with pluggable backends and formatters.
 * All components should use this instead of rolling their own loggers.
 */

import fs from "fs";
import path from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  close(): void;
  getFileSizeBytes?(): number;
  getFilePath?(): string | null;
  forceRotate?(): void;
}

export interface LoggerConfig {
  backend: "file" | "console";
  format: "pretty" | "json";
  path?: string;
  level?: LogLevel;
  maxSizeBytes?: number;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

function formatTimestamp(date: Date): string {
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  const s = date.getSeconds().toString().padStart(2, "0");
  const ms = date.getMilliseconds().toString().padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function formatFields(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields);
  if (keys.length === 0) return "";

  const parts = keys.map((key) => {
    const val = fields[key];
    if (val === undefined) return `  ${key}: undefined`;
    if (val === null) return `  ${key}: null`;
    if (typeof val === "object") {
      const json = JSON.stringify(val, null, 2);
      // Indent nested JSON
      const indented = json.split("\n").join("\n    ");
      return `  ${key}: ${indented}`;
    }
    return `  ${key}: ${typeof val === 'string' ? val : JSON.stringify(val)}`;
  });

  return "\n" + parts.join("\n");
}

export function formatPretty(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {}
): string {
  const timestamp = formatTimestamp(new Date());
  const label = LEVEL_LABELS[level];
  const fieldStr = formatFields(fields);
  return `[${timestamp}] ${label} | ${msg}${fieldStr}`;
}

export function formatJson(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message: msg,
    ...fields,
  });
}

class FileLogger implements Logger {
  private stream: fs.WriteStream | null = null;
  private minLevel: number;
  private formatter: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => string;
  private filePath: string | null = null;
  private maxSizeBytes: number;
  private currentSizeBytes = 0;
  private rotateInProgress = false;

  constructor(config: LoggerConfig) {
    this.minLevel = LEVEL_PRIORITY[config.level ?? "debug"];
    this.formatter = config.format === "json" ? formatJson : formatPretty;
    this.maxSizeBytes = config.maxSizeBytes ?? 50 * 1024 * 1024; // 50MB default

    if (config.path) {
      this.filePath = config.path;
      try {
        const dir = path.dirname(config.path);
        fs.mkdirSync(dir, { recursive: true });
        this.stream = fs.createWriteStream(config.path, { flags: "a" });
        // Get initial file size
        if (fs.existsSync(config.path)) {
          this.currentSizeBytes = fs.statSync(config.path).size;
        }
      } catch {
        this.stream = null;
      }
    }
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (!this.stream) return;
    if (LEVEL_PRIORITY[level] < this.minLevel) return;

    try {
      const line = this.formatter(level, msg, fields);
      const bytes = Buffer.byteLength(line + "\n", "utf8");
      this.stream.write(line + "\n");
      this.currentSizeBytes += bytes;

      // Check if rotation needed
      if (this.currentSizeBytes >= this.maxSizeBytes && !this.rotateInProgress) {
        this.rotate();
      }
    } catch {
      // Swallow to avoid disrupting the system
    }
  }

  private rotate(): void {
    if (!this.filePath || this.rotateInProgress) return;
    this.rotateInProgress = true;

    try {
      this.stream?.end();

      // Read file, keep last 60% of lines (trim oldest 40%)
      const content = fs.readFileSync(this.filePath, "utf8");
      const lines = content.split("\n");
      const keepFrom = Math.floor(lines.length * 0.4);
      const trimmedContent = lines.slice(keepFrom).join("\n");

      fs.writeFileSync(this.filePath, trimmedContent);
      this.currentSizeBytes = Buffer.byteLength(trimmedContent, "utf8");

      this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
    } catch {
      // If rotation fails, just continue
    } finally {
      this.rotateInProgress = false;
    }
  }

  getFileSizeBytes(): number {
    return this.currentSizeBytes;
  }

  getFilePath(): string | null {
    return this.filePath;
  }

  forceRotate(): void {
    if (this.currentSizeBytes > 0) {
      this.rotate();
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write("debug", msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.write("info", msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write("warn", msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.write("error", msg, fields);
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

class ConsoleLogger implements Logger {
  private minLevel: number;
  private formatter: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => string;

  constructor(config: LoggerConfig) {
    this.minLevel = LEVEL_PRIORITY[config.level ?? "debug"];
    this.formatter = config.format === "json" ? formatJson : formatPretty;
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < this.minLevel) return;

    const line = this.formatter(level, msg, fields);
    switch (level) {
      case "debug":
        console.debug(line);
        break;
      case "info":
        console.log(line);
        break;
      case "warn":
        console.warn(line);
        break;
      case "error":
        console.error(line);
        break;
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write("debug", msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.write("info", msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write("warn", msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.write("error", msg, fields);
  }

  close(): void {
    // No-op for console
  }
}

export function createLogger(config: LoggerConfig): Logger {
  if (config.backend === "console") {
    return new ConsoleLogger(config);
  }
  return new FileLogger(config);
}

/**
 * No-op logger for testing or when logging should be disabled.
 */
export const nullLogger: Logger = {
  debug: () => { /* noop */ },
  info: () => { /* noop */ },
  warn: () => { /* noop */ },
  error: () => { /* noop */ },
  close: () => { /* noop */ },
};
