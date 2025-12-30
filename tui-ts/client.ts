import { EventEmitter } from "events";
import readline from "readline";
import type { ChildProcessWithoutNullStreams } from "child_process";
import type { BridgeCommand, BridgeEvent } from "./types.js";

export class JSONLClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private writeQueue: string[] = [];
  private writing = false;
  private closed = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    super();
    this.child = child;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleLine(line));
    rl.on("close", () => {
      this.emit("close");
    });

    child.on("exit", (code, signal) => {
      this.emit("exit", { code, signal });
    });

    child.on("error", (error) => {
      this.emit("error", { message: "Bridge process error", detail: String(error) });
    });
  }

  send(command: BridgeCommand): void {
    if (this.closed) {
      return;
    }
    const payload = `${JSON.stringify(command)}\n`;
    this.writeQueue.push(payload);
    this.flushQueue();
  }

  close(): void {
    this.closed = true;
    this.writeQueue = [];
    if (this.child.stdin.writable) {
      this.child.stdin.end();
    }
  }

  private flushQueue(): void {
    if (this.writing || this.closed) {
      return;
    }
    this.writing = true;

    const writeNext = () => {
      const next = this.writeQueue.shift();
      if (!next) {
        this.writing = false;
        return;
      }

      if (!this.child.stdin.writable) {
        this.writing = false;
        return;
      }

      const ok = this.child.stdin.write(next, "utf8", () => {
        setImmediate(writeNext);
      });

      if (!ok) {
        this.child.stdin.once("drain", () => setImmediate(writeNext));
      }
    };

    setImmediate(writeNext);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let event: BridgeEvent | null = null;
    try {
      event = JSON.parse(trimmed) as BridgeEvent;
    } catch (error) {
      this.emit("error", {
        message: "Invalid JSON from bridge",
        detail: String(error),
      });
      return;
    }

    if (!event.type) {
      this.emit("error", { message: "Bridge event missing type", detail: trimmed });
      return;
    }

    this.emit("event", event);
  }
}
