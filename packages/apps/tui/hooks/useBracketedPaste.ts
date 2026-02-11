import { useEffect, useRef } from "react";

/**
 * Bracketed paste mode sequences:
 * - Start: ESC[200~ (\x1b[200~)
 * - End: ESC[201~ (\x1b[201~)
 *
 * When enabled, terminals wrap pasted content with these sequences,
 * allowing the application to distinguish between typed and pasted text.
 */

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const PASTE_START_REGEX = /\x1b\[200~/;
const PASTE_END_REGEX = /\x1b\[201~/;
const ASYNC_PASTE_THRESHOLD = 512 * 1024;
const PASTE_CHUNK_SIZE = 64 * 1024;

interface UseBracketedPasteOptions {
  /**
   * Called when a complete paste operation is detected.
   * The text is the pasted content with bracketed paste sequences removed.
   */
  onPaste: (text: string) => void;
  /**
   * Called during a large paste operation to report progress.
   * bytes: number of bytes received so far
   */
  onPasteProgress?: (bytes: number) => void;
  /**
   * Called when paste starts (optional).
   */
  onPasteStart?: () => void;
  /**
   * Called when paste ends or is cancelled (optional).
   */
  onPasteEnd?: () => void;
  /**
   * Whether bracketed paste mode is enabled. Defaults to true.
   */
  enabled?: boolean;
}

/**
 * Hook to handle bracketed paste mode in terminal applications.
 *
 * Enables bracketed paste mode on mount and handles detecting paste
 * start/end sequences to capture pasted text as a single unit.
 *
 * Benefits:
 * - Large pastes arrive as a single callback instead of many keystrokes
 * - Preserves formatting/indentation of pasted text
 * - Can show progress for very large pastes
 */
export function useBracketedPaste(options: UseBracketedPasteOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Extract enabled so we can use it as a dependency
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!enabled) return;

    const stdin = process.stdin;
    if (!stdin.isTTY) return;

    // Enable bracketed paste mode
    process.stdout.write("\x1b[?2004h");

    let buffer = "";
    let isPasting = false;
    let pasteBuffer = "";
    let pendingPasteChunks: string[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    let pendingPasteCompletion: (() => void) | null = null;

    const flushPasteChunks = (): void => {
      flushTimer = null;
      const start = Date.now();
      while (pendingPasteChunks.length > 0) {
        const chunk = pendingPasteChunks.shift();
        if (chunk) {
          optionsRef.current.onPaste(chunk);
        }
        if (Date.now() - start > 8) {
          break;
        }
      }

      if (pendingPasteChunks.length > 0) {
        flushTimer = setTimeout(flushPasteChunks, 0);
      } else if (pendingPasteCompletion) {
        const onComplete = pendingPasteCompletion;
        pendingPasteCompletion = null;
        onComplete();
      }
    };

    const queuePasteText = (text: string, onComplete?: () => void): void => {
      if (text.length <= ASYNC_PASTE_THRESHOLD) {
        optionsRef.current.onPaste(text);
        onComplete?.();
        return;
      }

      for (let i = 0; i < text.length; i += PASTE_CHUNK_SIZE) {
        pendingPasteChunks.push(text.slice(i, i + PASTE_CHUNK_SIZE));
      }

      if (onComplete) {
        pendingPasteCompletion = onComplete;
      }

      if (!flushTimer) {
        flushTimer = setTimeout(flushPasteChunks, 0);
      }
    };

    const handleData = (data: Buffer): void => {
      const str = data.toString("utf8");

      // If not currently pasting, look for paste start sequence
      if (!isPasting) {
        buffer += str;

        // Check for paste start
        const startMatch = buffer.match(PASTE_START_REGEX);
        if (startMatch) {
          isPasting = true;
          const startIdx = buffer.indexOf(BRACKETED_PASTE_START);
          // Everything before the start sequence should be processed normally (ignored here)
          // Everything after is paste content
          pasteBuffer = buffer.slice(startIdx + BRACKETED_PASTE_START.length);
          buffer = "";

          optionsRef.current.onPasteStart?.();

          // Check if end is already in this chunk
          if (PASTE_END_REGEX.test(pasteBuffer)) {
            const endIdx = pasteBuffer.indexOf(BRACKETED_PASTE_END);
            const pastedText = pasteBuffer.slice(0, endIdx);
            const afterEnd = pasteBuffer.slice(endIdx + BRACKETED_PASTE_END.length);

            pasteBuffer = "";
            isPasting = false;

            queuePasteText(pastedText, () => {
              optionsRef.current.onPasteEnd?.();
            });

            // Put anything after the end sequence back in buffer
            if (afterEnd) {
              buffer = afterEnd;
            }
            return;
          }

          optionsRef.current.onPasteProgress?.(pasteBuffer.length);
          return;
        }

        // Prevent buffer from growing indefinitely
        if (buffer.length > 1024) {
          buffer = buffer.slice(-256);
        }
        return;
      }

      // Currently pasting - accumulate data
      pasteBuffer += str;

      // Check for paste end
      if (PASTE_END_REGEX.test(pasteBuffer)) {
        const endIdx = pasteBuffer.indexOf(BRACKETED_PASTE_END);
        const pastedText = pasteBuffer.slice(0, endIdx);
        const afterEnd = pasteBuffer.slice(endIdx + BRACKETED_PASTE_END.length);

        pasteBuffer = "";
        isPasting = false;

        queuePasteText(pastedText, () => {
          optionsRef.current.onPasteEnd?.();
        });

        // Put anything after the end sequence back in buffer
        if (afterEnd) {
          buffer = afterEnd;
        }
        return;
      }

      // Report progress for large pastes
      optionsRef.current.onPasteProgress?.(pasteBuffer.length);

      // Safety limit: if paste is extremely large (>10MB), flush it
      if (pasteBuffer.length > 10 * 1024 * 1024) {
        const partialText = pasteBuffer;
        pasteBuffer = "";
        isPasting = false;

        queuePasteText(partialText, () => {
          optionsRef.current.onPasteEnd?.();
        });
      }
    };

    stdin.on("data", handleData);

    return () => {
      stdin.off("data", handleData);
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingPasteChunks = [];
      pendingPasteCompletion = null;
      // Disable bracketed paste mode
      process.stdout.write("\x1b[?2004l");
    };
  }, [enabled]);
}

/**
 * Formats bytes into a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
