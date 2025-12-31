export interface ParsedCommand {
  command: string;
  arg?: string;
}

export const SLASH_COMMANDS = [
  "/help",
  "/config",
  "/models",
  "/status",
  "/compact",
  "/voice",
  "/top",
  "/bottom",
  "/clear",
  "/quit",
  "/exit",
];

export function parseSlashCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const parts = trimmed.split(/\s+/, 2);
  return { command: parts[0].toLowerCase(), arg: parts[1] };
}

export const HELP_LINES: string[] = [
  "Commands:",
  "  /help           Show this help",
  "  /config         Show config summary",
  "  /models         Show API key status",
  "  /compact        Toggle compact mode",
  "  /voice          Toggle voice mode",
  "  /status         Show runtime status",
  "  /top            Jump to top of history",
  "  /bottom         Jump to bottom of history",
  "  /clear          Clear history",
  "  /quit           Quit the TUI",
  "",
  "Scrolling:",
  "  Mouse wheel     Scroll history up/down",
  "  PageUp/Down     Scroll one page",
  "  Home/End        Jump to top/bottom",
  "",
  "Keybindings:",
  "  Enter           Send message",
  "  Shift+Enter     Insert newline",
  "  Tab             Accept autocomplete",
  "  Esc             Dismiss autocomplete or stop voice",
  "  Ctrl+A/E        Move to start/end",
  "  Ctrl+U          Clear input",
  "  Ctrl+W          Delete previous word",
  "  F1 or Ctrl+K    Toggle help",
  "",
  "Autocomplete:",
  "  Trigger with @ at token start or after whitespace.",
  "  Use Tab or Enter to accept.",
];
