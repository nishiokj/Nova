/**
 * TUI Constants
 *
 * Centralized constants for configuration and tuning.
 * Changes here should be minimal and intentional.
 */

// ============================================
// UI LAYOUT
// ============================================

/** Maximum number of input lines to display before scrolling */
export const DEFAULT_MAX_INPUT_LINES = 6;

/** Horizontal padding (in characters) on each side of content */
export const HORIZONTAL_PADDING = 2;

/** Top padding (in lines) */
export const TOP_PADDING = 1;

/** Bottom padding (in lines) */
export const BOTTOM_PADDING = 1;

/** Minimum terminal width (characters) */
export const MIN_TERMINAL_WIDTH = 40;

/** Minimum terminal height (lines) */
export const MIN_TERMINAL_HEIGHT = 10;

// ============================================
// PROMPT MODAL SIZING
// ============================================

/** Minimum width required for PermissionPrompt to render properly */
export const MIN_PERMISSION_WIDTH = 60;

/** Minimum height required for PermissionPrompt to render properly */
export const MIN_PERMISSION_HEIGHT = 12;

/** Maximum height for prompt content before scrolling is needed */
export const PROMPT_MAX_CONTENT_HEIGHT = 20;

/** Default terminal width fallback */
export const DEFAULT_TERMINAL_WIDTH = 80;

/** Default terminal height fallback */
export const DEFAULT_TERMINAL_HEIGHT = 24;

/** Lines to scroll per mouse wheel tick */
export const SCROLL_AMOUNT = 3;

// ============================================
// ANIMATION & TIMING
// ============================================

/** Frames for streaming cursor animation */
export const STREAM_CURSOR_FRAMES = ["|", " "] as const;

/** Frames for status spinner animation (braille sweep) */
export const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Frames for input prompt spinner when agent is busy (star rotation) */
export const INPUT_SPINNER_FRAMES = ["✦", "✶", "✳", "✴", "✳", "✶"] as const;

/** Interval (ms) between status animation ticks */
export const STATUS_TICK_INTERVAL = 80;

/** Session stale threshold (seconds) - 5 minutes */
export const SESSION_STALE_THRESHOLD = 5 * 60;

/** Network request timeout (ms) - 10 seconds */
export const NETWORK_TIMEOUT = 10000;

/** File cache refresh interval (ms) - 5 seconds */
export const FILE_CACHE_REFRESH_INTERVAL = 5000;

/** Session cleanup delay before disconnect (ms) - must be long enough for round-trip */
export const CLEANUP_DELAY = 300;

/** Delay for graceful shutdown on signal (ms) */
export const GRACEFUL_SHUTDOWN_DELAY = 500;

/** Delay for error exit after cleanup (ms) */
export const ERROR_EXIT_DELAY = 100;

// ============================================
// CONTENT LIMITS
// ============================================

/** Maximum streaming text size - 5MB (from store.ts) */
export const MAX_STREAMING_BYTES = 5 * 1024 * 1024;

/** Maximum input length - 100KB (from store.ts) */
export const MAX_INPUT_LENGTH = 100 * 1024;

/** Default history line limit (from store.ts) */
export const DEFAULT_MAX_HISTORY = 500;

// ============================================
// NETWORK DEFAULTS
// ============================================

/** Default GraphD host */
export const DEFAULT_GRAPHD_HOST = "127.0.0.1";

/** Default GraphD port */
export const DEFAULT_GRAPHD_PORT = "9444";

/** Default event bus host */
export const DEFAULT_EVENT_BUS_HOST = "127.0.0.1";

/** Default event bus port */
export const DEFAULT_EVENT_BUS_PORT = 9555;

// ============================================
// REQUEST ID GENERATION
// ============================================

/** Hex radix for random number generation */
export const RANDOM_HEX_RADIX = 16;

/** Request ID random string slice start index */
export const REQUEST_ID_SLICE_START = 2;

/** Request ID random string slice end index */
export const REQUEST_ID_SLICE_END = 8;

/** ISO date slice length (YYYY-MM-DD) */
export const ISO_DATE_SLICE = 10;
