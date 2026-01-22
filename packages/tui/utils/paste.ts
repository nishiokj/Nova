/**
 * Paste handling utilities for TUI.
 * Shared across components that need to handle bracketed paste mode.
 */

/**
 * Strip bracketed paste escape sequences from input.
 *
 * Bracketed paste mode sends escape sequences:
 * - \x1b[200~ - paste start
 * - \x1b[201~ - paste end
 *
 * These need to be cleaned from the actual text content.
 */
export function stripPasteMarkers(str: string): string {
  return str
    // Full escape sequences
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    // Without escape char (already stripped by control char filter)
    .replace(/\[200~/g, "")
    .replace(/\[201~/g, "")
    // Catch any remaining bracket-number-tilde patterns
    .replace(/\[20[01]~/g, "");
}
