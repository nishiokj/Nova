import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  getColors,
  getCurrentTheme,
  getCurrentThemeName,
  getThemeNames,
  setTheme,
  themes,
} from 'tui/theme.js';
import type { ThemeColors } from 'tui/theme.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Filesystem side-effect verification
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), '.config', 'jesus-tui');
const CONFIG_FILE = join(CONFIG_DIR, 'preferences.json');

function readPersistedTheme(): string | undefined {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')).theme;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

// Save the original file content so we can restore after all tests
const originalConfigExists = existsSync(CONFIG_FILE);
const originalConfigContent = originalConfigExists
  ? readFileSync(CONFIG_FILE, 'utf-8')
  : null;

afterAll(() => {
  // Restore original config state
  if (originalConfigContent !== null) {
    writeFileSync(CONFIG_FILE, originalConfigContent);
  } else if (existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE);
  }
});

// ---------------------------------------------------------------------------
// Required ThemeColors fields
// ---------------------------------------------------------------------------

const REQUIRED_COLOR_KEYS: (keyof ThemeColors)[] = [
  'text', 'code', 'path', 'func', 'url', 'number',
  'header', 'bold', 'italic', 'strikethrough', 'blockquote',
  'listBullet', 'link', 'linkText', 'hr',
  'muted', 'border', 'accent',
  'success', 'error', 'warning', 'info',
  'diffAdd', 'diffRemove', 'diffHeader',
];

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TUI Theme System', () => {
  beforeEach(() => {
    // Reset to default theme before each test
    setTheme('mocha');
  });

  // --- getThemeNames ---

  describe('getThemeNames', () => {
    it('returns all registered theme keys', () => {
      const names = getThemeNames();
      expect(names).toEqual(Object.keys(themes));
    });

    it('includes mocha, frappe, rosepine, moon, tokyo, nord, gruvbox, kanagawa, everforest, onedark', () => {
      const names = getThemeNames();
      const expected = [
        'mocha', 'frappe', 'rosepine', 'moon', 'tokyo',
        'nord', 'gruvbox', 'kanagawa', 'everforest', 'onedark',
      ];
      for (const name of expected) {
        expect(names).toContain(name);
      }
    });
  });

  // --- getCurrentThemeName ---

  describe('getCurrentThemeName', () => {
    it('returns mocha as the default theme', () => {
      expect(getCurrentThemeName()).toBe('mocha');
    });

    it('reflects the most recent setTheme call', () => {
      setTheme('nord');
      expect(getCurrentThemeName()).toBe('nord');
    });
  });

  // --- getCurrentTheme ---

  describe('getCurrentTheme', () => {
    it('returns a theme object with name, description, and colors', () => {
      const theme = getCurrentTheme();
      expect(theme.name).toBe('Mocha');
      expect(typeof theme.description).toBe('string');
      expect(theme.description.length).toBeGreaterThan(0);
      expect(theme.colors).toBeDefined();
    });

    it('returns the theme matching the current theme name', () => {
      setTheme('tokyo');
      const theme = getCurrentTheme();
      expect(theme.name).toBe('Tokyo Night');
    });

    it('returns the themes registry object (identity)', () => {
      const theme = getCurrentTheme();
      expect(theme).toBe(themes.mocha);
    });
  });

  // --- getColors ---

  describe('getColors', () => {
    it('returns the colors of the current theme', () => {
      const colors = getColors();
      expect(colors).toBe(themes.mocha.colors);
    });

    it('returns mocha text color #bac2de by default', () => {
      expect(getColors().text).toBe('#bac2de');
    });

    it('switches to the selected theme colors', () => {
      setTheme('gruvbox');
      const colors = getColors();
      expect(colors.text).toBe('#ebdbb2');
      expect(colors.error).toBe('#fb4934');
      expect(colors.success).toBe('#b8bb26');
    });

    it('includes all required ThemeColors fields', () => {
      const colors = getColors();
      for (const key of REQUIRED_COLOR_KEYS) {
        expect(colors[key]).toBeDefined();
        expect(typeof colors[key]).toBe('string');
      }
    });

    it('all color values are valid hex color strings', () => {
      const colors = getColors();
      for (const key of REQUIRED_COLOR_KEYS) {
        expect(colors[key]).toMatch(HEX_COLOR_REGEX);
      }
    });
  });

  // --- setTheme ---

  describe('setTheme', () => {
    it('returns true for a valid theme name', () => {
      expect(setTheme('kanagawa')).toBe(true);
    });

    it('returns false for an unknown theme name', () => {
      expect(setTheme('nonexistent-theme')).toBe(false);
    });

    it('does not change the current theme on invalid name', () => {
      setTheme('nord');
      setTheme('nonexistent-theme');
      expect(getCurrentThemeName()).toBe('nord');
      expect(getColors().text).toBe('#ECEFF4');
    });

    it('changes getColors() output to the new theme', () => {
      const before = getColors().text;
      setTheme('rosepine');
      const after = getColors().text;
      expect(before).toBe('#bac2de');
      expect(after).toBe('#e0def4');
      expect(before).not.toBe(after);
    });

    it('switching between all themes produces distinct accent colors', () => {
      const accents = new Map<string, string>();
      for (const name of getThemeNames()) {
        setTheme(name);
        accents.set(name, getColors().accent);
      }
      // Mocha and frappe have different accent values
      expect(accents.get('mocha')).toBe('#cba6f7');
      expect(accents.get('gruvbox')).toBe('#d3869b');
      expect(accents.get('nord')).toBe('#88C0D0');
    });

    it('persists the theme choice to disk', () => {
      setTheme('everforest');
      const persisted = readPersistedTheme();
      expect(persisted).toBe('everforest');
    });

    it('invalid theme name does not overwrite persisted preference', () => {
      setTheme('tokyo');
      const beforePersisted = readPersistedTheme();
      setTheme('invalid-theme-name');
      const afterPersisted = readPersistedTheme();
      expect(beforePersisted).toBe('tokyo');
      expect(afterPersisted).toBe('tokyo');
    });
  });

  // --- all themes completeness ---

  describe('all themes completeness', () => {
    it('every theme has all required color fields as valid hex', () => {
      for (const [themeName, theme] of Object.entries(themes)) {
        for (const key of REQUIRED_COLOR_KEYS) {
          const value = theme.colors[key];
          expect(value, `${themeName}.${key} missing or not a string`).toBeDefined();
          expect(value, `${themeName}.${key} = "${value}" is not valid hex`).toMatch(
            HEX_COLOR_REGEX,
          );
        }
      }
    });

    it('every theme has a non-empty name and description', () => {
      for (const [key, theme] of Object.entries(themes)) {
        expect(theme.name.length, `${key}.name empty`).toBeGreaterThan(0);
        expect(theme.description.length, `${key}.description empty`).toBeGreaterThan(0);
      }
    });

    it('error and success colors differ within each theme', () => {
      for (const [key, theme] of Object.entries(themes)) {
        expect(
          theme.colors.error,
          `${key}: error and success colors should differ`,
        ).not.toBe(theme.colors.success);
      }
    });

    it('diffAdd matches success and diffRemove matches error for each theme', () => {
      for (const [key, theme] of Object.entries(themes)) {
        expect(theme.colors.diffAdd, `${key}: diffAdd !== success`).toBe(theme.colors.success);
        expect(theme.colors.diffRemove, `${key}: diffRemove !== error`).toBe(theme.colors.error);
      }
    });
  });
});
