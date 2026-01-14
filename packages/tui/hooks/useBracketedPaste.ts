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

            optionsRef.current.onPaste(pastedText);
            optionsRef.current.onPasteEnd?.();

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

        optionsRef.current.onPaste(pastedText);
        optionsRef.current.onPasteEnd?.();

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

        optionsRef.current.onPaste(partialText);
        optionsRef.current.onPasteEnd?.();
      }
    };

    stdin.on("data", handleData);

    return () => {
      stdin.off("data", handleData);
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
