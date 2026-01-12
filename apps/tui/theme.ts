/**
 * TUI Theme System
 *
 * Centralized color management with preset themes.
 * Switch themes with /theme command.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Config file location
const CONFIG_DIR = join(homedir(), ".config", "jesus-tui");
const CONFIG_FILE = join(CONFIG_DIR, "preferences.json");

interface Preferences {
  theme?: string;
}

function loadPreferences(): Preferences {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {
    // Ignore errors, return default
  }
  return {};
}

function savePreferences(prefs: Preferences): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(prefs, null, 2));
  } catch {
    // Ignore save errors
  }
}

export interface ThemeColors {
  // Role colors
  user: string;
  agent: string;
  system: string;
  status: string;
  // Syntax highlighting
  code: string;
  path: string;
  url: string;
  number: string;
  // UI
  muted: string;
  border: string;
  // Status levels
  success: string;
  error: string;
  warning: string;
  info: string;
}

export interface Theme {
  name: string;
  description: string;
  colors: ThemeColors;
}

// ============================================
// PRESET THEMES - Each has a genuinely different color palette
// ============================================

export const themes: Record<string, Theme> = {
  // Cool blues - user is sky blue, agent is soft lavender
  midnight: {
    name: "Midnight",
    description: "Cool blues and soft purples",
    colors: {
      user: "#7dd3fc",      // Sky blue
      agent: "#c4b5fd",     // Lavender
      system: "#fcd34d",    // Amber
      status: "#94a3b8",    // Slate
      code: "#fb923c",      // Orange
      path: "#7dd3fc",      // Sky
      url: "#a5b4fc",       // Indigo
      number: "#f0abfc",    // Fuchsia
      muted: "#64748b",     // Gray
      border: "#475569",    // Slate
      success: "#4ade80",   // Green
      error: "#f87171",     // Red
      warning: "#fbbf24",   // Yellow
      info: "#60a5fa",      // Blue
    },
  },

  // Warm sunset - user is coral/orange, agent is gold
  ember: {
    name: "Ember",
    description: "Warm oranges and golds",
    colors: {
      user: "#fb923c",      // Orange
      agent: "#fcd34d",     // Gold/Yellow
      system: "#f0abfc",    // Soft pink
      status: "#a8a29e",    // Warm gray
      code: "#f87171",      // Red
      path: "#fdba74",      // Light orange
      url: "#fbbf24",       // Amber
      number: "#fb7185",    // Rose
      muted: "#78716c",     // Stone
      border: "#57534e",    // Dark stone
      success: "#a3e635",   // Lime
      error: "#ef4444",     // Red
      warning: "#f59e0b",   // Amber
      info: "#fcd34d",      // Yellow
    },
  },

  // Ocean - user is teal, agent is coral
  ocean: {
    name: "Ocean",
    description: "Teals and corals",
    colors: {
      user: "#2dd4bf",      // Teal
      agent: "#fb7185",     // Rose/Coral
      system: "#a5f3fc",    // Light cyan
      status: "#6b7280",    // Gray
      code: "#fbbf24",      // Amber
      path: "#22d3ee",      // Cyan
      url: "#f472b6",       // Pink
      number: "#67e8f9",    // Light cyan
      muted: "#4b5563",     // Gray
      border: "#374151",    // Dark gray
      success: "#34d399",   // Emerald
      error: "#f87171",     // Red
      warning: "#fbbf24",   // Yellow
      info: "#22d3ee",      // Cyan
    },
  },

  // Forest - user is mint green, agent is warm brown
  forest: {
    name: "Forest",
    description: "Natural greens and earth tones",
    colors: {
      user: "#6ee7b7",      // Mint/Emerald
      agent: "#d4a574",     // Tan/Caramel
      system: "#a3e635",    // Lime
      status: "#71717a",    // Zinc
      code: "#fde047",      // Yellow
      path: "#86efac",      // Light green
      url: "#c4b5fd",       // Lavender
      number: "#bef264",    // Lime
      muted: "#52525b",     // Zinc
      border: "#3f3f46",    // Dark zinc
      success: "#4ade80",   // Green
      error: "#f87171",     // Red
      warning: "#facc15",   // Yellow
      info: "#6ee7b7",      // Emerald
    },
  },

  // Sakura - user is pink, agent is light purple
  sakura: {
    name: "Sakura",
    description: "Cherry blossom pinks",
    colors: {
      user: "#f9a8d4",      // Pink
      agent: "#c4b5fd",     // Lavender
      system: "#fef08a",    // Light yellow
      status: "#9ca3af",    // Gray
      code: "#fdba74",      // Peach
      path: "#f472b6",      // Hot pink
      url: "#a78bfa",       // Violet
      number: "#e879f9",    // Fuchsia
      muted: "#6b7280",     // Gray
      border: "#4b5563",    // Dark gray
      success: "#86efac",   // Light green
      error: "#fb7185",     // Rose
      warning: "#fde047",   // Yellow
      info: "#c4b5fd",      // Lavender
    },
  },

  // Monochrome - grayscale with blue accent
  mono: {
    name: "Mono",
    description: "Clean grayscale with blue accent",
    colors: {
      user: "#e5e5e5",      // Light gray (near white)
      agent: "#a3a3a3",     // Medium gray
      system: "#60a5fa",    // Blue accent
      status: "#737373",    // Gray
      code: "#60a5fa",      // Blue
      path: "#d4d4d4",      // Light gray
      url: "#93c5fd",       // Light blue
      number: "#60a5fa",    // Blue
      muted: "#525252",     // Dark gray
      border: "#404040",    // Darker gray
      success: "#86efac",   // Green
      error: "#f87171",     // Red
      warning: "#fbbf24",   // Yellow
      info: "#60a5fa",      // Blue
    },
  },

  // Neon - vibrant cyberpunk colors
  neon: {
    name: "Neon",
    description: "Electric cyberpunk colors",
    colors: {
      user: "#00ff9f",      // Neon green
      agent: "#ff00ff",     // Magenta
      system: "#ffff00",    // Yellow
      status: "#708090",    // Slate
      code: "#ff6b6b",      // Coral
      path: "#00d4ff",      // Electric blue
      url: "#ff00ff",       // Magenta
      number: "#00ff9f",    // Neon green
      muted: "#708090",     // Slate
      border: "#2d2d44",    // Dark purple
      success: "#00ff9f",   // Neon green
      error: "#ff0055",     // Hot pink
      warning: "#ffff00",   // Yellow
      info: "#00d4ff",      // Electric blue
    },
  },

  // Matrix - classic green on black hacker aesthetic
  matrix: {
    name: "Matrix",
    description: "Classic green terminal",
    colors: {
      user: "#00ff00",      // Bright green
      agent: "#00cc00",     // Medium green
      system: "#009900",    // Dark green
      status: "#006600",    // Darker green
      code: "#00ff00",      // Bright green
      path: "#33ff33",      // Light green
      url: "#66ff66",       // Lighter green
      number: "#00ff00",    // Bright green
      muted: "#004400",     // Very dark green
      border: "#003300",    // Near black green
      success: "#00ff00",   // Bright green
      error: "#ff0000",     // Red (only non-green)
      warning: "#99ff00",   // Yellow-green
      info: "#00ff99",      // Cyan-green
    },
  },
};

// ============================================
// THEME STATE
// ============================================

// Load saved theme or default to midnight
const prefs = loadPreferences();
let currentThemeName = (prefs.theme && themes[prefs.theme]) ? prefs.theme : "midnight";

export function getCurrentTheme(): Theme {
  return themes[currentThemeName] || themes.midnight;
}

export function getColors(): ThemeColors {
  return getCurrentTheme().colors;
}

export function setTheme(name: string): boolean {
  if (themes[name]) {
    currentThemeName = name;
    // Persist the selection
    savePreferences({ ...loadPreferences(), theme: name });
    return true;
  }
  return false;
}

export function getThemeNames(): string[] {
  return Object.keys(themes);
}

export function getCurrentThemeName(): string {
  return currentThemeName;
}
