export interface ParsedCommand {
  command: string;
  arg?: string;
}

export const SLASH_COMMANDS = [
  "/help",
  "/config",
  "/models",
  "/status",
  "/skills",
  "/hooks",
  "/delete",
  "/trash",
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

  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ");
  return { command, arg: arg || undefined };
}

export const HELP_LINES: string[] = [
  "Commands:",
  "  /help           Show this help",
  "  /config         Show config summary",
  "  /models         Show API key status",
  "  /skills         List skills",
  "  /skills new     Create a skill",
  "  /skills edit ID Edit a skill",
  "  /skills run ID  Run a skill",
  "  /skills enable ID  Enable a skill",
  "  /skills disable ID Disable a skill",
  "  /skills delete ID  Delete a skill",
  "  /hooks          List hooks",
  "  /hooks new      Create a hook",
  "  /hooks edit ID  Edit a hook",
  "  /hooks enable ID   Enable a hook",
  "  /hooks disable ID  Disable a hook",
  "  /hooks delete ID   Delete a hook",
  "  /delete         Delete a session (interactive)",
  "  /trash          Delete a session (interactive)",
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
