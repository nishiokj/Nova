import { useEffect, useRef } from "react";

/**
 * SGR (1006) mouse event format:
 * \x1b[<button;x;y(M|m)
 * - M = button pressed
 * - m = button released
 * - button 64 = scroll up
 * - button 65 = scroll down
 */

const MOUSE_SGR_REGEX = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// Scroll wheel button codes in SGR mode
const SCROLL_UP = 64;
const SCROLL_DOWN = 65;

interface UseMouseOptions {
  onScrollUp?: () => void;
  onScrollDown?: () => void;
  scrollLines?: number;
}

export function useMouse(options: UseMouseOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      return;
    }

    // Enable SGR extended mouse mode
    // \x1b[?1000h - Enable basic mouse tracking
    // \x1b[?1006h - Enable SGR extended mode (better for modern terminals)
    process.stdout.write("\x1b[?1000h\x1b[?1006h");

    let buffer = "";

    const handleData = (data: Buffer): void => {
      buffer += data.toString("utf8");

      // Process all complete mouse events in the buffer
      let match: RegExpExecArray | null;
      let lastIndex = 0;

      // Reset regex state
      MOUSE_SGR_REGEX.lastIndex = 0;

      while ((match = MOUSE_SGR_REGEX.exec(buffer)) !== null) {
        const button = parseInt(match[1], 10);

        // Handle scroll wheel events
        if (button === SCROLL_UP) {
          optionsRef.current.onScrollUp?.();
        } else if (button === SCROLL_DOWN) {
          optionsRef.current.onScrollDown?.();
        }

        lastIndex = match.index + match[0].length;
      }

      // Keep any incomplete sequence in the buffer
      if (lastIndex > 0) {
        buffer = buffer.slice(lastIndex);
      }

      // Prevent buffer from growing indefinitely if no matches
      if (buffer.length > 256) {
        buffer = buffer.slice(-64);
      }
    };

    stdin.on("data", handleData);

    return () => {
      stdin.off("data", handleData);
      // Disable mouse tracking on cleanup
      process.stdout.write("\x1b[?1006l\x1b[?1000l");
    };
  }, []);
}
