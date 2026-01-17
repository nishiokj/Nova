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
  // Primary text - neutral color for all messages (user, agent, system)
  text: string;
  // Syntax highlighting - themed colors for code elements
  code: string;
  path: string;
  func: string;
  url: string;
  number: string;
  // Markdown formatting
  header: string;
  bold: string;
  italic: string;
  strikethrough: string;
  blockquote: string;
  listBullet: string;
  link: string;
  linkText: string;
  hr: string;
  // UI chrome
  muted: string;
  border: string;
  accent: string;
  userBg: string;  // Background color for user message blocks
  // Status levels
  success: string;
  error: string;
  warning: string;
  info: string;
  // Diff colors
  diffAdd: string;
  diffRemove: string;
  diffAddBg: string;
  diffRemoveBg: string;
  diffHeader: string;     // File header text (e.g., "✓ Edit /path/to/file.ts")
  diffHeaderBg: string;   // File header background
}

export interface Theme {
  name: string;
  description: string;
  colors: ThemeColors;
}

// ============================================
// PRESET THEMES - Based on popular color schemes
// ============================================

export const themes: Record<string, Theme> = {
  // Catppuccin Mocha - Most popular pastel dark theme
  // https://github.com/catppuccin/catppuccin
  mocha: {
    name: "Mocha",
    description: "Catppuccin's soothing pastel dark",
    colors: {
      text: "#bac2de",      // Subtext1 - neutral lavender-grey
      code: "#fab387",      // Peach
      path: "#94e2d5",      // Teal
      func: "#89b4fa",      // Blue
      url: "#89dceb",       // Sky
      number: "#f5c2e7",    // Pink
      header: "#cba6f7",    // Mauve - markdown headers
      bold: "#f5e0dc",      // Rosewater - bold text
      italic: "#b4befe",    // Lavender - italic text
      strikethrough: "#6c7086", // Overlay0 - dimmed for strikethrough
      blockquote: "#a6adc8", // Subtext0 - slightly muted for quotes
      listBullet: "#f5c2e7", // Pink - list markers
      link: "#89dceb",       // Sky - link URLs
      linkText: "#89b4fa",   // Blue - link text
      hr: "#585b70",         // Surface2 - horizontal rules
      muted: "#6c7086",     // Overlay0
      border: "#45475a",    // Surface1
      accent: "#cba6f7",    // Mauve - for headers/UI
      userBg: "#45475a",    // Surface1 - user message background (more visible)
      success: "#a6e3a1",   // Green
      error: "#f38ba8",     // Red
      warning: "#f9e2af",   // Yellow
      info: "#74c7ec",      // Sapphire
      diffAdd: "#a6e3a1",   // Green - same as success
      diffRemove: "#f38ba8", // Red - same as error
      diffAddBg: "#1e3a1e",   // Dark green background
      diffRemoveBg: "#3a1e1e", // Dark red background
      diffHeader: "#89b4fa", // Blue - file path header
      diffHeaderBg: "#313244", // Surface0 - subtle background
    },
  },

  // Catppuccin Frappe - Softer dark variant
  frappe: {
    name: "Frappe",
    description: "Catppuccin's muted pastel dark",
    colors: {
      text: "#b5bfe2",      // Subtext1 - neutral lavender-grey
      code: "#ef9f76",      // Peach
      path: "#81c8be",      // Teal
      func: "#8caaee",      // Blue
      url: "#99d1db",       // Sky
      number: "#f4b8e4",    // Pink
      header: "#ca9ee6",    // Mauve - markdown headers
      bold: "#f2d5cf",      // Rosewater - bold text
      italic: "#babbf1",    // Lavender - italic text
      strikethrough: "#737994", // Overlay0
      blockquote: "#a5adce", // Subtext0
      listBullet: "#f4b8e4", // Pink
      link: "#99d1db",       // Sky
      linkText: "#8caaee",   // Blue
      hr: "#626880",         // Surface2
      muted: "#737994",     // Overlay0
      border: "#51576d",    // Surface1
      accent: "#ca9ee6",    // Mauve
      userBg: "#51576d",    // Surface1 - user message background (more visible)
      success: "#a6d189",   // Green
      error: "#e78284",     // Red
      warning: "#e5c890",   // Yellow
      info: "#85c1dc",      // Sapphire
      diffAdd: "#a6d189",   // Green
      diffRemove: "#e78284", // Red
      diffAddBg: "#1e3a1e",   // Dark green background
      diffRemoveBg: "#3a1e1e", // Dark red background
      diffHeader: "#8caaee", // Blue - file path header
      diffHeaderBg: "#414559", // Surface0 - subtle background
    },
  },

  // Rose Pine - Soho vibes, elegant and muted
  // https://rosepinetheme.com/palette/
  rosepine: {
    name: "Rose Pine",
    description: "Soho vibes, elegant muted tones",
    colors: {
      text: "#e0def4",      // Text - soft white with purple tint
      code: "#ebbcba",      // Rose
      path: "#31748f",      // Pine
      func: "#9ccfd8",      // Foam
      url: "#c4a7e7",       // Iris
      number: "#eb6f92",    // Love
      header: "#c4a7e7",    // Iris - markdown headers
      bold: "#e0def4",      // Text - bold
      italic: "#908caa",    // Subtle - italic
      strikethrough: "#6e6a86", // Muted
      blockquote: "#908caa", // Subtle
      listBullet: "#eb6f92", // Love
      link: "#c4a7e7",       // Iris
      linkText: "#9ccfd8",   // Foam
      hr: "#524f67",         // Highlight high
      muted: "#6e6a86",     // Muted
      border: "#403d52",    // Highlight med
      accent: "#c4a7e7",    // Iris
      userBg: "#403d52",    // Highlight med - user message background (more visible)
      success: "#31748f",   // Pine
      error: "#eb6f92",     // Love
      warning: "#f6c177",   // Gold
      info: "#9ccfd8",      // Foam
      diffAdd: "#31748f",   // Pine
      diffRemove: "#eb6f92", // Love
      diffAddBg: "#1a2e2e",   // Dark teal background
      diffRemoveBg: "#2e1a22", // Dark rose background
      diffHeader: "#9ccfd8", // Foam - file path header
      diffHeaderBg: "#26233a", // Highlight low - subtle background
    },
  },

  // Rose Pine Moon - Slightly brighter variant
  moon: {
    name: "Moon",
    description: "Rose Pine's brighter variant",
    colors: {
      text: "#e0def4",      // Text - soft white with purple tint
      code: "#ea9a97",      // Rose (moon)
      path: "#3e8fb0",      // Pine (moon)
      func: "#9ccfd8",      // Foam
      url: "#c4a7e7",       // Iris
      number: "#eb6f92",    // Love
      header: "#c4a7e7",    // Iris - markdown headers
      bold: "#e0def4",      // Text - bold
      italic: "#908caa",    // Subtle - italic
      strikethrough: "#6e6a86", // Muted
      blockquote: "#908caa", // Subtle
      listBullet: "#eb6f92", // Love
      link: "#c4a7e7",       // Iris
      linkText: "#9ccfd8",   // Foam
      hr: "#56526e",         // Highlight high
      muted: "#6e6a86",     // Muted
      border: "#44415a",    // Highlight med
      accent: "#c4a7e7",    // Iris
      userBg: "#44415a",    // Highlight med - user message background (more visible)
      success: "#3e8fb0",   // Pine
      error: "#eb6f92",     // Love
      warning: "#f6c177",   // Gold
      info: "#9ccfd8",      // Foam
      diffAdd: "#3e8fb0",   // Pine
      diffRemove: "#eb6f92", // Love
      diffAddBg: "#1a2e2e",   // Dark teal background
      diffRemoveBg: "#2e1a22", // Dark rose background
      diffHeader: "#9ccfd8", // Foam - file path header
      diffHeaderBg: "#2a273f", // Highlight low - subtle background
    },
  },

  // Tokyo Night - Clean neon-inspired theme
  // https://github.com/folke/tokyonight.nvim
  tokyo: {
    name: "Tokyo Night",
    description: "Clean neon lights of Tokyo",
    colors: {
      text: "#c0caf5",      // Foreground - soft blue-white
      code: "#f7768e",      // Red/Pink
      path: "#73daca",      // Teal
      func: "#7aa2f7",      // Blue
      url: "#7dcfff",       // Cyan
      number: "#ff9e64",    // Orange
      header: "#bb9af7",    // Purple - markdown headers
      bold: "#c0caf5",      // Foreground - bold
      italic: "#9aa5ce",    // Foreground dim - italic
      strikethrough: "#565f89", // Comment
      blockquote: "#9aa5ce", // Foreground dim
      listBullet: "#ff9e64", // Orange
      link: "#7dcfff",       // Cyan
      linkText: "#7aa2f7",   // Blue
      hr: "#414868",         // Terminal black
      muted: "#565f89",     // Comment
      border: "#3b4261",    // Border
      accent: "#bb9af7",    // Purple
      userBg: "#3b4261",    // Border - user message background (more visible)
      success: "#9ece6a",   // Green
      error: "#f7768e",     // Red
      warning: "#e0af68",   // Yellow
      info: "#7dcfff",      // Cyan
      diffAdd: "#9ece6a",   // Green
      diffRemove: "#f7768e", // Red
      diffAddBg: "#1a2e1a",   // Dark green background
      diffRemoveBg: "#2e1a1e", // Dark red background
      diffHeader: "#7aa2f7", // Blue - file path header
      diffHeaderBg: "#1f2335", // Background highlight - subtle background
    },
  },

  // Nord - Arctic, north-bluish color palette
  // https://www.nordtheme.com/docs/colors-and-palettes
  nord: {
    name: "Nord",
    description: "Arctic, cool blue palette",
    colors: {
      text: "#ECEFF4",      // Nord6 - Snow storm white
      code: "#D08770",      // Nord12 - Orange
      path: "#8FBCBB",      // Nord7 - Calm accent
      func: "#88C0D0",      // Nord8 - Bright accent
      url: "#81A1C1",       // Nord9 - Blue
      number: "#B48EAD",    // Nord15 - Purple
      header: "#88C0D0",    // Nord8 - markdown headers
      bold: "#ECEFF4",      // Nord6 - bold
      italic: "#D8DEE9",    // Nord4 - italic
      strikethrough: "#4C566A", // Nord3
      blockquote: "#D8DEE9", // Nord4
      listBullet: "#D08770", // Nord12
      link: "#81A1C1",       // Nord9
      linkText: "#88C0D0",   // Nord8
      hr: "#434C5E",         // Nord2
      muted: "#4C566A",     // Nord3 - Bright black
      border: "#3B4252",    // Nord1 - Dark
      accent: "#88C0D0",    // Nord8
      userBg: "#4C566A",    // Nord3 - user message background (more visible)
      success: "#A3BE8C",   // Nord14 - Green
      error: "#BF616A",     // Nord11 - Red
      warning: "#EBCB8B",   // Nord13 - Yellow
      info: "#88C0D0",      // Nord8 - Cyan
      diffAdd: "#A3BE8C",   // Nord14 - Green
      diffRemove: "#BF616A", // Nord11 - Red
      diffAddBg: "#1e2e1e",   // Dark green background
      diffRemoveBg: "#2e1e1e", // Dark red background
      diffHeader: "#88C0D0", // Nord8 - file path header
      diffHeaderBg: "#3B4252", // Nord1 - subtle background
    },
  },

  // Gruvbox - Warm retro theme
  // https://github.com/morhetz/gruvbox
  gruvbox: {
    name: "Gruvbox",
    description: "Warm retro groove colors",
    colors: {
      text: "#ebdbb2",      // Foreground - warm cream
      code: "#fe8019",      // Bright orange
      path: "#8ec07c",      // Bright aqua
      func: "#83a598",      // Bright blue
      url: "#83a598",       // Bright blue
      number: "#d3869b",    // Bright purple
      header: "#d3869b",    // Bright purple - markdown headers
      bold: "#fbf1c7",      // Light0 - bold
      italic: "#d5c4a1",    // Light2 - italic
      strikethrough: "#665c54", // Dark3
      blockquote: "#bdae93", // Light3
      listBullet: "#fe8019", // Bright orange
      link: "#83a598",       // Bright blue
      linkText: "#8ec07c",   // Bright aqua
      hr: "#7c6f64",         // Dark4
      muted: "#665c54",     // Dark3
      border: "#504945",    // Dark2
      accent: "#d3869b",    // Bright purple
      userBg: "#504945",    // Dark2 - user message background (more visible)
      success: "#b8bb26",   // Bright green
      error: "#fb4934",     // Bright red
      warning: "#fabd2f",   // Bright yellow
      info: "#83a598",      // Bright blue
      diffAdd: "#b8bb26",   // Bright green
      diffRemove: "#fb4934", // Bright red
      diffAddBg: "#2a2e1a",   // Dark olive background
      diffRemoveBg: "#2e1a1a", // Dark red background
      diffHeader: "#83a598", // Bright blue - file path header
      diffHeaderBg: "#3c3836", // Dark1 - subtle background
    },
  },

  // Kanagawa - Japanese-inspired, Hokusai painting
  // https://github.com/rebelot/kanagawa.nvim
  kanagawa: {
    name: "Kanagawa",
    description: "Inspired by Hokusai's The Great Wave",
    colors: {
      text: "#DCD7BA",      // Fuji white - warm neutral
      code: "#FFA066",      // Surimi orange
      path: "#7FB4CA",      // Spring blue
      func: "#7E9CD8",      // Crystal blue
      url: "#A3D4D5",       // Light blue
      number: "#D27E99",    // Sakura pink
      header: "#957FB8",    // Oni violet - markdown headers
      bold: "#DCD7BA",      // Fuji white - bold
      italic: "#C8C093",    // Old white - italic
      strikethrough: "#727169", // Fuji gray
      blockquote: "#C8C093", // Old white
      listBullet: "#FFA066", // Surimi orange
      link: "#A3D4D5",       // Light blue
      linkText: "#7E9CD8",   // Crystal blue
      hr: "#625e5a",         // Fuji gray dim
      muted: "#727169",     // Fuji gray
      border: "#54546D",    // Sumi ink6
      accent: "#957FB8",    // Oni violet
      userBg: "#54546D",    // Sumi ink6 - user message background (more visible)
      success: "#76946A",   // Autumn green
      error: "#E82424",     // Samurai red
      warning: "#FF9E3B",   // Ronin yellow
      info: "#7E9CD8",      // Crystal blue
      diffAdd: "#76946A",   // Autumn green
      diffRemove: "#E82424", // Samurai red
      diffAddBg: "#1e2a1e",   // Dark green background
      diffRemoveBg: "#2a1e1e", // Dark red background
      diffHeader: "#7E9CD8", // Crystal blue - file path header
      diffHeaderBg: "#2A2A37", // Sumi ink4 - subtle background
    },
  },

  // Everforest - Green-based, easy on eyes
  // https://github.com/sainnhe/everforest
  everforest: {
    name: "Everforest",
    description: "Comfortable green forest tones",
    colors: {
      text: "#d3c6aa",      // Foreground - warm grey
      code: "#e69875",      // Orange
      path: "#83c092",      // Green
      func: "#7fbbb3",      // Aqua
      url: "#7fbbb3",       // Aqua
      number: "#d699b6",    // Purple
      header: "#a7c080",    // Green - markdown headers
      bold: "#d3c6aa",      // Foreground - bold
      italic: "#9da9a0",    // Gray2 - italic
      strikethrough: "#7a8478", // Gray1
      blockquote: "#9da9a0", // Gray2
      listBullet: "#e69875", // Orange
      link: "#7fbbb3",       // Aqua
      linkText: "#83c092",   // Green
      hr: "#5c6a60",         // Gray0
      muted: "#7a8478",     // Gray1
      border: "#4f5b58",    // Gray0 dim
      accent: "#a7c080",    // Green
      userBg: "#4f5b58",    // Gray0 dim - user message background (more visible)
      success: "#a7c080",   // Bright green
      error: "#e67e80",     // Red
      warning: "#dbbc7f",   // Yellow
      info: "#7fbbb3",      // Aqua
      diffAdd: "#a7c080",   // Bright green
      diffRemove: "#e67e80", // Red
      diffAddBg: "#1e2a1e",   // Dark green background
      diffRemoveBg: "#2a1e1e", // Dark red background
      diffHeader: "#7fbbb3", // Aqua - file path header
      diffHeaderBg: "#374145", // Bg2 - subtle background
    },
  },

  // One Dark - Atom's iconic theme
  // https://github.com/navarasu/onedark.nvim
  onedark: {
    name: "One Dark",
    description: "Atom's iconic dark theme",
    colors: {
      text: "#abb2bf",      // Foreground - neutral grey
      code: "#d19a66",      // Orange
      path: "#56b6c2",      // Cyan
      func: "#61afef",      // Blue
      url: "#61afef",       // Blue
      number: "#c678dd",    // Purple
      header: "#c678dd",    // Purple - markdown headers
      bold: "#abb2bf",      // Foreground - bold
      italic: "#848b98",    // Comment bright - italic
      strikethrough: "#5c6370", // Comment gray
      blockquote: "#848b98", // Comment bright
      listBullet: "#d19a66", // Orange
      link: "#61afef",       // Blue
      linkText: "#56b6c2",   // Cyan
      hr: "#4b5263",         // Gutter gray bright
      muted: "#5c6370",     // Comment gray
      border: "#3e4451",    // Gutter gray
      accent: "#c678dd",    // Purple
      userBg: "#3e4451",    // Gutter gray - user message background (more visible)
      success: "#98c379",   // Green
      error: "#e06c75",     // Red
      warning: "#e5c07b",   // Yellow
      info: "#56b6c2",      // Cyan
      diffAdd: "#98c379",   // Green
      diffRemove: "#e06c75", // Red
      diffAddBg: "#1e2a1e",   // Dark green background
      diffRemoveBg: "#2a1e1e", // Dark red background
      diffHeader: "#61afef", // Blue - file path header
      diffHeaderBg: "#2c323c", // Gutter bg - subtle background
    },
  },
};

// ============================================
// THEME STATE
// ============================================

// Load saved theme or default to mocha (Catppuccin)
const prefs = loadPreferences();
let currentThemeName = (prefs.theme && themes[prefs.theme]) ? prefs.theme : "mocha";

export function getCurrentTheme(): Theme {
  return themes[currentThemeName] || themes.mocha;
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
