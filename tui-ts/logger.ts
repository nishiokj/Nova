import fs from "fs";
import path from "path";

export interface LoggerOptions {
  logPath: string;
  redact: boolean;
  logTranscripts: boolean;
}

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

  private write(level: string, message: string, fields: Record<string, unknown> = {}): void {
    if (!this.stream) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...fields,
    };

    try {
      this.stream.write(`${JSON.stringify(entry)}\n`);
    } catch (error) {
      // Ignore logging errors to avoid breaking the UI.
    }
  }
}
