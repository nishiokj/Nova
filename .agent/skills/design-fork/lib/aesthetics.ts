/**
 * Aesthetic presets for design-fork skill.
 */

export interface AestheticPreset {
  id: string;
  name: string;
  description: string;
  modifiers: string[];
  temperature: number;
}

export const AESTHETIC_PRESETS: AestheticPreset[] = [
  {
    id: 'minimal-mono',
    name: 'Minimal Monochrome',
    description: 'Ultra-clean, whitespace-heavy, single accent color',
    modifiers: [
      'Swiss design influence',
      'Thin hairline borders',
      'Maximum negative space',
      'Single accent color only',
    ],
    temperature: 0.7,
  },
  {
    id: 'dark-glass',
    name: 'Dark Glassmorphism',
    description: 'Dark mode with frosted glass effects',
    modifiers: [
      'Frosted glass panels with blur',
      'Subtle gradient backgrounds',
      'Neon accent glows',
      'Translucent layers',
    ],
    temperature: 0.85,
  },
  {
    id: 'neobrutalism',
    name: 'Neobrutalism',
    description: 'Bold borders, harsh shadows, visible grid',
    modifiers: [
      'Bold 3-4px borders',
      'Harsh drop shadows (no blur)',
      'Solid background colors',
      'Visible grid structure',
    ],
    temperature: 1.0,
  },
  {
    id: 'soft-gradients',
    name: 'Soft Gradients',
    description: 'Gentle color transitions, rounded shapes',
    modifiers: [
      'Smooth color gradients',
      'Large border-radius (16-24px)',
      'Soft colored shadows',
      'Pastel color palette',
    ],
    temperature: 0.8,
  },
  {
    id: 'dense-data',
    name: 'Dense Data',
    description: 'Terminal-inspired, maximum information density',
    modifiers: [
      'Compact spacing (4-8px)',
      'Monospace typography',
      'High contrast text',
      'Grid-based layout',
    ],
    temperature: 0.75,
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Magazine-style, dramatic typography',
    modifiers: [
      'Large display headings',
      'Asymmetric grid layouts',
      'High contrast black/white',
      'Serif accent fonts',
    ],
    temperature: 0.9,
  },
  {
    id: 'retro-futurism',
    name: 'Retro Futurism',
    description: 'CRT aesthetic, vintage computing',
    modifiers: [
      'Scanline overlay effect',
      'Amber or green on black',
      'Pixel/bitmap fonts',
      'Rounded CRT corners',
    ],
    temperature: 1.1,
  },
  {
    id: 'corporate-clean',
    name: 'Corporate Clean',
    description: 'Enterprise-safe, professional',
    modifiers: [
      'Blue/gray color palette',
      'Conservative spacing',
      'Standard UI patterns',
      'Accessible contrast ratios',
    ],
    temperature: 0.7,
  },
  {
    id: 'playful-bold',
    name: 'Playful Bold',
    description: 'Vibrant colors, bouncy shapes',
    modifiers: [
      'Saturated primary colors',
      'Rounded bouncy shapes',
      'Generous padding (24-32px)',
      'Playful illustrations',
    ],
    temperature: 1.0,
  },
  {
    id: 'luxury-dark',
    name: 'Luxury Dark',
    description: 'Premium feel, sophisticated',
    modifiers: [
      'Gold/champagne accents',
      'Serif display headings',
      'Subtle texture overlays',
      'Deep black backgrounds',
    ],
    temperature: 0.85,
  },
];

/**
 * Get an aesthetic by ID.
 */
export function getAesthetic(id: string): AestheticPreset | undefined {
  return AESTHETIC_PRESETS.find((a) => a.id === id);
}

/**
 * Select N random aesthetics for exploration.
 */
export function selectAesthetics(n: number): AestheticPreset[] {
  const shuffled = [...AESTHETIC_PRESETS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, AESTHETIC_PRESETS.length));
}

/**
 * Get temperature multiplier based on N count.
 * Lower N = more focused = lower temperature.
 * Higher N = more exploration = higher temperature.
 */
export function getTemperatureForN(n: number, baseTemp: number): number {
  if (n <= 3) return baseTemp * 0.85;
  if (n <= 5) return baseTemp * 0.95;
  if (n <= 7) return baseTemp * 1.0;
  return baseTemp * 1.05;
}
