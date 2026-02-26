/**
 * Color palettes and typography presets for design-fork skill.
 */

export interface ColorPalette {
  id: string;
  name: string;
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  textMuted: string;
  border: string;
  success: string;
  warning: string;
  error: string;
}

export interface TypographyPreset {
  id: string;
  name: string;
  headingFont: string;
  bodyFont: string;
  monoFont: string;
}

export const COLOR_PALETTES: ColorPalette[] = [
  {
    id: 'slate',
    name: 'Slate',
    primary: '#3b82f6',
    secondary: '#64748b',
    accent: '#06b6d4',
    background: '#0f172a',
    surface: '#1e293b',
    text: '#f8fafc',
    textMuted: '#94a3b8',
    border: '#334155',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
  },
  {
    id: 'zinc',
    name: 'Zinc',
    primary: '#a855f7',
    secondary: '#71717a',
    accent: '#ec4899',
    background: '#09090b',
    surface: '#18181b',
    text: '#fafafa',
    textMuted: '#a1a1aa',
    border: '#27272a',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
  },
  {
    id: 'warm',
    name: 'Warm',
    primary: '#f97316',
    secondary: '#78716c',
    accent: '#eab308',
    background: '#1c1917',
    surface: '#292524',
    text: '#fafaf9',
    textMuted: '#a8a29e',
    border: '#44403c',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
  },
  {
    id: 'emerald',
    name: 'Emerald',
    primary: '#10b981',
    secondary: '#6b7280',
    accent: '#14b8a6',
    background: '#111827',
    surface: '#1f2937',
    text: '#f9fafb',
    textMuted: '#9ca3af',
    border: '#374151',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
  },
  {
    id: 'rose',
    name: 'Rose',
    primary: '#f43f5e',
    secondary: '#78716c',
    accent: '#fb7185',
    background: '#0c0a09',
    surface: '#1c1917',
    text: '#fafaf9',
    textMuted: '#a8a29e',
    border: '#292524',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
  },
  {
    id: 'light-minimal',
    name: 'Light Minimal',
    primary: '#18181b',
    secondary: '#71717a',
    accent: '#3b82f6',
    background: '#ffffff',
    surface: '#fafafa',
    text: '#09090b',
    textMuted: '#71717a',
    border: '#e4e4e7',
    success: '#16a34a',
    warning: '#ca8a04',
    error: '#dc2626',
  },
  {
    id: 'cream',
    name: 'Cream',
    primary: '#b45309',
    secondary: '#78716c',
    accent: '#d97706',
    background: '#fefce8',
    surface: '#fef9c3',
    text: '#422006',
    textMuted: '#a16207',
    border: '#fde047',
    success: '#16a34a',
    warning: '#ca8a04',
    error: '#dc2626',
  },
  {
    id: 'neon',
    name: 'Neon',
    primary: '#00ff88',
    secondary: '#00ccff',
    accent: '#ff00ff',
    background: '#000000',
    surface: '#0a0a0a',
    text: '#ffffff',
    textMuted: '#888888',
    border: '#222222',
    success: '#00ff88',
    warning: '#ffff00',
    error: '#ff0044',
  },
  {
    id: 'retro-amber',
    name: 'Retro Amber',
    primary: '#fbbf24',
    secondary: '#92400e',
    accent: '#f59e0b',
    background: '#0c0a09',
    surface: '#1c1917',
    text: '#fbbf24',
    textMuted: '#d97706',
    border: '#451a03',
    success: '#84cc16',
    warning: '#fbbf24',
    error: '#ef4444',
  },
  {
    id: 'corporate',
    name: 'Corporate',
    primary: '#2563eb',
    secondary: '#64748b',
    accent: '#0891b2',
    background: '#f8fafc',
    surface: '#ffffff',
    text: '#1e293b',
    textMuted: '#64748b',
    border: '#e2e8f0',
    success: '#16a34a',
    warning: '#ca8a04',
    error: '#dc2626',
  },
];

export const AESTHETIC_PALETTE_MAP: Record<string, string[]> = {
  'minimal-mono': ['light-minimal', 'zinc', 'slate'],
  'dark-glass': ['slate', 'zinc', 'emerald'],
  neobrutalism: ['warm', 'rose', 'cream'],
  'soft-gradients': ['emerald', 'rose', 'corporate'],
  'dense-data': ['slate', 'zinc', 'neon'],
  editorial: ['light-minimal', 'zinc', 'warm'],
  'retro-futurism': ['retro-amber', 'neon', 'zinc'],
  'corporate-clean': ['corporate', 'slate', 'light-minimal'],
  'playful-bold': ['rose', 'warm', 'emerald'],
  'luxury-dark': ['zinc', 'warm', 'slate'],
};

export const TYPOGRAPHY_PRESETS: TypographyPreset[] = [
  {
    id: 'system',
    name: 'System',
    headingFont: 'system-ui, -apple-system, sans-serif',
    bodyFont: 'system-ui, -apple-system, sans-serif',
    monoFont: 'ui-monospace, monospace',
  },
  {
    id: 'editorial',
    name: 'Editorial',
    headingFont: 'Georgia, serif',
    bodyFont: 'system-ui, sans-serif',
    monoFont: 'ui-monospace, monospace',
  },
  {
    id: 'geometric',
    name: 'Geometric',
    headingFont: 'Avenir, Montserrat, sans-serif',
    bodyFont: 'Avenir, Montserrat, sans-serif',
    monoFont: 'SF Mono, monospace',
  },
  {
    id: 'technical',
    name: 'Technical',
    headingFont: 'JetBrains Mono, monospace',
    bodyFont: 'Inter, system-ui, sans-serif',
    monoFont: 'JetBrains Mono, monospace',
  },
  {
    id: 'modern',
    name: 'Modern',
    headingFont: 'Inter, system-ui, sans-serif',
    bodyFont: 'Inter, system-ui, sans-serif',
    monoFont: 'Fira Code, monospace',
  },
];

/**
 * Get a palette by ID.
 */
export function getPalette(id: string): ColorPalette | undefined {
  return COLOR_PALETTES.find((p) => p.id === id);
}

/**
 * Get compatible palettes for an aesthetic.
 */
export function getPalettesForAesthetic(aestheticId: string): ColorPalette[] {
  const paletteIds = AESTHETIC_PALETTE_MAP[aestheticId] ?? ['slate'];
  return paletteIds.map((id) => getPalette(id)).filter(Boolean) as ColorPalette[];
}

/**
 * Get a typography preset by ID.
 */
export function getTypography(id: string): TypographyPreset | undefined {
  return TYPOGRAPHY_PRESETS.find((t) => t.id === id);
}

/**
 * Get a random typography preset.
 */
export function getRandomTypography(): TypographyPreset {
  return TYPOGRAPHY_PRESETS[Math.floor(Math.random() * TYPOGRAPHY_PRESETS.length)];
}
