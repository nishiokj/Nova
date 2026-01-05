import fs from "fs";
import path from "path";

export interface LoggerOptions {
  logPath: string;
  redact: boolean;
  logTranscripts: boolean;
}

const LEVEL_LABELS: Record<string, string> = {
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
  transcript: "TRANS",
};

export class UILogger {
  private stream: fs.WriteStream | null = null;
  private redact: boolean;
  private logTranscripts: boolean;

  constructor(options: LoggerOptions) {
    this.redact = options.redact;
    this.logTranscripts = options.logTranscripts;

    try {
      const dir = path.dirname(options.logPath);
      fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(options.logPath, { flags: "a" });
    } catch (error) {
      this.stream = null;
    }
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write("error", message, fields);
  }

  transcript(kind: "user" | "voice" | "system", text: string): void {
    if (!this.logTranscripts) {
      return;
    }

    const payload = this.redact ? "[REDACTED]" : text;
    this.write("transcript", `${kind}: ${payload}`);
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }

  private formatTimestamp(date: Date): string {
    const h = date.getHours().toString().padStart(2, "0");
    const m = date.getMinutes().toString().padStart(2, "0");
    const s = date.getSeconds().toString().padStart(2, "0");
    const ms = date.getMilliseconds().toString().padStart(3, "0");
    return `${h}:${m}:${s}.${ms}`;
  }

  private formatFields(fields: Record<string, unknown>): string {
    const keys = Object.keys(fields);
    if (keys.length === 0) return "";

    const parts = keys.map((key) => {
      const val = fields[key];
      const formatted =
        typeof val === "object" ? JSON.stringify(val, null, 2) : String(val);
      return `  ${key}: ${formatted}`;
    });

    return "\n" + parts.join("\n");
  }

  private write(level: string, message: string, fields: Record<string, unknown> = {}): void {
    if (!this.stream) {
      return;
    }

    const now = new Date();
    const timestamp = this.formatTimestamp(now);
    const label = LEVEL_LABELS[level] ?? level.toUpperCase().padEnd(5);
    const fieldStr = this.formatFields(fields);

    const line = `[${timestamp}] ${label} │ ${message}${fieldStr}\n`;

    try {
      this.stream.write(line);
    } catch (error) {
      // Ignore logging errors to avoid breaking the UI.
    }
  }
}
