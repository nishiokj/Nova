# /design-fork - Design Exploration Skill Spec (v0)

## Overview

Generate N divergent UI design concepts as images, display them for selection, then deconstruct the chosen design(s) into a scaffolded project spec.

**Core insight**: Use image generation for entropy (visual diversity), not LLM code gen (which converges). Deconstruct only after selection to save compute.

---

## User Flow

```
User: /design-fork "analytics dashboard for SaaS metrics"

┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: Configuration                                                  │
│                                                                         │
│   How many design directions? [3] [5] [10]                              │
│   └── Lower N = higher confidence = lower temperature                  │
│                                                                         │
│   Display mode? [tmux grid] [browser gallery]                          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: Parallel Image Generation                                      │
│                                                                         │
│   Generating 10 design concepts...                                      │
│   ████████████░░░░░░░░ 6/10                                             │
│                                                                         │
│   Each uses different aesthetic prompt + temperature                    │
│   All share: color palette, typography, JSON-structured layout prompt   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: Display & Selection                                            │
│                                                                         │
│   TMUX MODE:                          BROWSER MODE:                     │
│   ┌─────┬─────┬─────┬─────┬─────┐    Opens localhost:3333               │
│   │  1  │  2  │  3  │  4  │  5  │    with image gallery                 │
│   ├─────┼─────┼─────┼─────┼─────┤    Click to select                    │
│   │  6  │  7  │  8  │  9  │ 10  │                                       │
│   └─────┴─────┴─────┴─────┴─────┘                                       │
│                                                                         │
│   Select favorites (1-3): _                                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: Vision Deconstruction (only for selected)                      │
│                                                                         │
│   Analyzing design #7...                                                │
│   - Extracting layout structure                                         │
│   - Identifying components                                              │
│   - Mapping color palette                                               │
│   - Inferring state flows                                               │
│                                                                         │
│   Output: DesignSpec JSON                                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PHASE 5: Project Scaffold                                               │
│                                                                         │
│   Created: packages/my-dashboard/                                       │
│   ├── design-spec.json      # Full DesignSpec                           │
│   ├── reference.png         # Selected design image                    │
│   ├── src/                                                              │
│   │   ├── components/       # Stubbed component files                  │
│   │   ├── pages/            # Route structure                          │
│   │   └── styles/                                                       │
│   │       ├── tokens.css    # Extracted color/spacing tokens           │
│   │       └── theme.ts      # Theme configuration                      │
│   └── README.md             # Design rationale + next steps            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Image Generation Integration

### 1.1 Provider: Flux 2 Schnell (via Replicate or Together)

**Why Flux Schnell:**
- $0.015/image (10 images = $0.15)
- 2-5 second generation time
- Good enough quality for design direction selection
- Widely available APIs

**API Integration:**

```typescript
// packages/tools/src/builtins/image-gen.ts

interface ImageGenParams {
  prompt: string;
  width?: number;   // default 1024
  height?: number;  // default 768 (landscape for dashboards)
  seed?: number;    // for reproducibility
}

interface ImageGenResult {
  url: string;
  localPath: string;  // downloaded to temp dir
  seed: number;
}

async function generateImage(params: ImageGenParams): Promise<ImageGenResult> {
  // Replicate API call to black-forest-labs/flux-schnell
  // Download result to local temp file for display
}
```

**Environment Config:**

```json
// config/harness_config.json
{
  "image_gen": {
    "provider": "replicate",
    "model": "black-forest-labs/flux-schnell",
    "api_key_env": "REPLICATE_API_TOKEN",
    "defaults": {
      "width": 1024,
      "height": 768
    }
  }
}
```

### 1.2 Alternative Providers (Future)

| Provider | Model | Cost | Speed | Notes |
|----------|-------|------|-------|-------|
| Replicate | flux-schnell | $0.015 | 2-5s | Primary |
| Together | flux-schnell | ~$0.01 | 2-5s | Cheaper |
| Gemini | 2.5 Flash Image | $0.039 | Fast | Good quality |
| Recraft | V3 SVG | $0.08 | ~10s | Vector output |

---

## 2. Display Modes

### 2.1 tmux Grid Mode

For users already in tmux. Uses sixel or kitty graphics protocol for inline images.

```typescript
// packages/tui/utils/design-display.ts

import { execSync } from 'child_process';

interface DisplayGridOptions {
  images: string[];      // local file paths
  columns: number;       // grid columns (default: 5 for 10 images)
  labelPrefix: string;   // "[1]", "[2]", etc.
}

function displayInTmux(options: DisplayGridOptions): void {
  const { images, columns } = options;
  const rows = Math.ceil(images.length / columns);

  // Create tmux grid layout
  for (let i = 1; i < images.length; i++) {
    if (i % columns === 0) {
      // New row
      execSync(`tmux split-window -v`);
    } else {
      // Same row, new column
      execSync(`tmux split-window -h`);
    }
  }

  // Select-layout for even distribution
  execSync(`tmux select-layout tiled`);

  // Display images in each pane using kitty icat or chafa
  images.forEach((img, idx) => {
    const paneId = idx;
    const label = `[${idx + 1}]`;

    // Try kitty graphics first, fallback to chafa (ASCII)
    const displayCmd = `
      if command -v kitten &> /dev/null; then
        kitten icat --place 40x30@0x0 "${img}" && echo "${label}"
      elif command -v chafa &> /dev/null; then
        chafa -s 40x30 "${img}" && echo "${label}"
      else
        echo "${label} ${img}"
      fi
    `;

    execSync(`tmux send-keys -t ${paneId} '${displayCmd}' Enter`);
  });
}
```

**Terminal Graphics Support Detection:**

```typescript
function detectGraphicsSupport(): 'kitty' | 'sixel' | 'chafa' | 'none' {
  // Check TERM, KITTY_WINDOW_ID, etc.
  if (process.env.KITTY_WINDOW_ID) return 'kitty';
  if (process.env.TERM?.includes('sixel')) return 'sixel';

  // Check for chafa CLI
  try {
    execSync('command -v chafa', { stdio: 'pipe' });
    return 'chafa';
  } catch {
    return 'none';
  }
}
```

### 2.2 Browser Gallery Mode

For users without tmux or who prefer GUI selection.

```typescript
// packages/tools/src/builtins/design-gallery-server.ts

import { createServer } from 'http';
import { readFileSync } from 'fs';

interface GalleryOptions {
  images: { path: string; label: string; metadata: object }[];
  port: number;          // default 3333
  onSelect: (indices: number[]) => void;
}

function startGalleryServer(options: GalleryOptions): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Design Fork - Select Favorites</title>
  <style>
    body {
      font-family: system-ui;
      background: #0a0a0a;
      color: #fafafa;
      padding: 2rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 1rem;
    }
    .card {
      border: 2px solid transparent;
      border-radius: 8px;
      overflow: hidden;
      cursor: pointer;
      transition: all 0.2s;
    }
    .card:hover { border-color: #666; }
    .card.selected { border-color: #22c55e; box-shadow: 0 0 20px #22c55e44; }
    .card img { width: 100%; aspect-ratio: 4/3; object-fit: cover; }
    .card .label {
      padding: 0.5rem;
      text-align: center;
      font-weight: bold;
    }
    .actions {
      margin-top: 2rem;
      text-align: center;
    }
    button {
      background: #22c55e;
      color: black;
      border: none;
      padding: 1rem 2rem;
      font-size: 1.2rem;
      border-radius: 8px;
      cursor: pointer;
    }
    button:disabled { opacity: 0.5; }
  </style>
</head>
<body>
  <h1>Select Your Favorite Design(s)</h1>
  <p>Click to select up to 3 designs, then confirm.</p>

  <div class="grid">
    ${options.images.map((img, i) => `
      <div class="card" data-index="${i}" onclick="toggle(${i})">
        <img src="/image/${i}" alt="Design ${i + 1}">
        <div class="label">[${i + 1}]</div>
      </div>
    `).join('')}
  </div>

  <div class="actions">
    <button onclick="confirm()" id="confirmBtn" disabled>
      Confirm Selection (0/3)
    </button>
  </div>

  <script>
    const selected = new Set();
    const maxSelections = 3;

    function toggle(idx) {
      const card = document.querySelector(\`[data-index="\${idx}"]\`);
      if (selected.has(idx)) {
        selected.delete(idx);
        card.classList.remove('selected');
      } else if (selected.size < maxSelections) {
        selected.add(idx);
        card.classList.add('selected');
      }
      updateButton();
    }

    function updateButton() {
      const btn = document.getElementById('confirmBtn');
      btn.disabled = selected.size === 0;
      btn.textContent = \`Confirm Selection (\${selected.size}/\${maxSelections})\`;
    }

    async function confirm() {
      await fetch('/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indices: [...selected] })
      });
      document.body.innerHTML = '<h1>Selection received! Return to terminal.</h1>';
    }
  </script>
</body>
</html>
  `;

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else if (req.url?.startsWith('/image/')) {
        const idx = parseInt(req.url.split('/')[2]);
        const img = readFileSync(options.images[idx].path);
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(img);
      } else if (req.url === '/select' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          const { indices } = JSON.parse(body);
          options.onSelect(indices);
          res.writeHead(200);
          res.end('OK');
          server.close();
          resolve();
        });
      }
    });

    server.listen(options.port, () => {
      console.log(`Gallery: http://localhost:${options.port}`);
      // Auto-open browser
      execSync(`open http://localhost:${options.port}`);
    });
  });
}
```

---

## 3. Prompt Engineering for Maximum Divergence

### 3.1 Base Prompt Structure

Every image prompt follows this structure to ensure "computer-programmable" appearance:

```typescript
interface DesignPromptParams {
  userRequest: string;       // "analytics dashboard for SaaS"
  aesthetic: AestheticPreset;
  colorPalette: ColorPalette;
  typography: TypographySpec;
  layoutHints: string[];
}

function buildImagePrompt(params: DesignPromptParams): string {
  return `
UI design mockup, high fidelity wireframe style, clean vector aesthetic.

APPLICATION: ${params.userRequest}

LAYOUT STRUCTURE (JSON-like visual hierarchy):
{
  "header": {
    "type": "navigation-bar",
    "contains": ["logo", "nav-links", "user-avatar"]
  },
  "sidebar": {
    "type": "vertical-nav",
    "contains": ["menu-items", "collapse-toggle"]
  },
  "main": {
    "type": "content-grid",
    "sections": [
      { "type": "stat-cards", "count": 4 },
      { "type": "chart-area", "variant": "line-chart" },
      { "type": "data-table", "columns": 5 }
    ]
  }
}

COLOR PALETTE:
- Primary: ${params.colorPalette.primary}
- Secondary: ${params.colorPalette.secondary}
- Background: ${params.colorPalette.background}
- Surface: ${params.colorPalette.surface}
- Text: ${params.colorPalette.text}

TYPOGRAPHY:
- Headings: ${params.typography.headings}
- Body: ${params.typography.body}
- Monospace: ${params.typography.mono}

AESTHETIC DIRECTION:
${params.aesthetic.description}

REQUIREMENTS:
- Clear visual hierarchy with labeled sections
- Distinguishable UI components (buttons, inputs, cards)
- Realistic placeholder text and data
- Professional, production-ready appearance
- ${params.aesthetic.modifiers.join('\n- ')}
`.trim();
}
```

### 3.2 Aesthetic Presets (10 Divergent Directions)

```typescript
// config/design-fork/aesthetics.ts

export interface AestheticPreset {
  id: string;
  name: string;
  description: string;
  modifiers: string[];
  temperature: number;  // 0.7-1.2 range
}

export const AESTHETIC_PRESETS: AestheticPreset[] = [
  {
    id: 'minimal-mono',
    name: 'Minimal Monochrome',
    description: 'Ultra-clean, whitespace-heavy, single accent color, Swiss design influence',
    modifiers: [
      'Maximum negative space',
      'Single accent color for CTAs only',
      'Thin hairline borders',
      'Large typography hierarchy'
    ],
    temperature: 0.7
  },
  {
    id: 'dark-glass',
    name: 'Dark Glassmorphism',
    description: 'Dark mode with frosted glass effects, subtle gradients, depth through blur',
    modifiers: [
      'Dark background (#0a0a0a to #1a1a1a)',
      'Frosted glass card backgrounds',
      'Subtle backdrop blur effects',
      'Neon accent glows'
    ],
    temperature: 0.85
  },
  {
    id: 'neobrutalist',
    name: 'Neobrutalism',
    description: 'Bold borders, harsh shadows, raw aesthetic, intentionally "undesigned"',
    modifiers: [
      'Thick black borders (3-4px)',
      'Hard drop shadows offset 4-6px',
      'Solid background colors',
      'Visible grid structure'
    ],
    temperature: 1.0
  },
  {
    id: 'soft-gradient',
    name: 'Soft Gradients',
    description: 'Gentle color transitions, rounded corners, comfortable and approachable',
    modifiers: [
      'Subtle gradient backgrounds',
      'Large border-radius (16-24px)',
      'Soft shadows with color tint',
      'Pastel color palette'
    ],
    temperature: 0.8
  },
  {
    id: 'dense-data',
    name: 'Dense Data',
    description: 'Information-dense, terminal-inspired, maximum data per viewport',
    modifiers: [
      'Compact spacing (4-8px)',
      'Small but readable typography',
      'Multiple data tables visible',
      'Monospace fonts for numbers'
    ],
    temperature: 0.75
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Magazine-inspired, strong typography, asymmetric layouts',
    modifiers: [
      'Large display typography',
      'Asymmetric grid layouts',
      'High contrast text',
      'Pull quotes and callouts'
    ],
    temperature: 0.9
  },
  {
    id: 'retro-future',
    name: 'Retro Futurism',
    description: 'CRT aesthetic, scanlines, vintage sci-fi, amber/green terminals',
    modifiers: [
      'CRT screen curvature effect',
      'Scanline overlays',
      'Amber or green on black',
      'Pixel/bitmap font style'
    ],
    temperature: 1.1
  },
  {
    id: 'corporate-clean',
    name: 'Corporate Clean',
    description: 'Enterprise-safe, blue/gray palette, conventional and trustworthy',
    modifiers: [
      'Blue primary color (#2563eb)',
      'Gray neutral palette',
      'Conservative spacing',
      'Standard component patterns'
    ],
    temperature: 0.7
  },
  {
    id: 'playful-bold',
    name: 'Playful Bold',
    description: 'Vibrant colors, bouncy feel, friendly and engaging',
    modifiers: [
      'Saturated color palette',
      'Rounded, bouncy shapes',
      'Illustrated elements',
      'Generous padding'
    ],
    temperature: 1.0
  },
  {
    id: 'luxury-dark',
    name: 'Luxury Dark',
    description: 'Premium feel, gold accents, sophisticated and exclusive',
    modifiers: [
      'Deep black backgrounds',
      'Gold/champagne accents',
      'Serif typography for headings',
      'Subtle texture overlays'
    ],
    temperature: 0.85
  }
];
```

### 3.3 Color Palette Generation

Pre-generate harmonious palettes to ensure visual coherence:

```typescript
// config/design-fork/palettes.ts

export interface ColorPalette {
  id: string;
  name: string;
  primary: string;
  secondary: string;
  background: string;
  surface: string;
  text: string;
  accent?: string;
}

export const COLOR_PALETTES: ColorPalette[] = [
  {
    id: 'slate',
    name: 'Slate',
    primary: '#3b82f6',
    secondary: '#64748b',
    background: '#ffffff',
    surface: '#f8fafc',
    text: '#0f172a'
  },
  {
    id: 'midnight',
    name: 'Midnight',
    primary: '#8b5cf6',
    secondary: '#6366f1',
    background: '#09090b',
    surface: '#18181b',
    text: '#fafafa'
  },
  {
    id: 'forest',
    name: 'Forest',
    primary: '#22c55e',
    secondary: '#16a34a',
    background: '#052e16',
    surface: '#14532d',
    text: '#dcfce7'
  },
  // ... 7 more palettes
];

// Map aesthetics to compatible palettes
export const AESTHETIC_PALETTE_MAP: Record<string, string[]> = {
  'minimal-mono': ['slate', 'stone', 'zinc'],
  'dark-glass': ['midnight', 'slate-dark', 'violet'],
  'neobrutalist': ['yellow-black', 'pink-black', 'lime-black'],
  'soft-gradient': ['rose', 'sky', 'lavender'],
  // ...
};
```

### 3.4 Typography Specs

```typescript
export interface TypographySpec {
  id: string;
  headings: string;  // Font family description
  body: string;
  mono: string;
}

export const TYPOGRAPHY_PRESETS: TypographySpec[] = [
  {
    id: 'system',
    headings: 'Inter, system-ui, bold weights',
    body: 'Inter, system-ui, regular weight',
    mono: 'JetBrains Mono, monospace'
  },
  {
    id: 'editorial',
    headings: 'Playfair Display, serif, high contrast',
    body: 'Source Sans Pro, clean sans-serif',
    mono: 'Fira Code, ligatures'
  },
  {
    id: 'geometric',
    headings: 'Poppins, geometric sans, bold',
    body: 'Poppins, geometric sans, regular',
    mono: 'Space Mono, retro'
  },
  // ...
];
```

### 3.5 Temperature Scaling with N

```typescript
function getTemperatureForN(n: number, baseTemp: number): number {
  // Lower N = user has clearer vision = lower temperature
  // Higher N = exploration mode = higher temperature

  const scale = {
    3: 0.85,   // Focused: reduce temp by 15%
    5: 0.95,   // Moderate: reduce temp by 5%
    10: 1.05,  // Exploratory: increase temp by 5%
  };

  const multiplier = scale[n as keyof typeof scale] ?? 1.0;
  return Math.min(1.3, Math.max(0.6, baseTemp * multiplier));
}
```

---

## 4. Vision Deconstruction (Post-Selection)

### 4.1 Deconstruction Prompt

Only run after user selects favorites. Uses standard agent with vision.

```typescript
const DECONSTRUCTION_SYSTEM_PROMPT = `
You are a UI/UX analyst. Given a design mockup image, extract a structured specification.

OUTPUT FORMAT (JSON):
{
  "layout": {
    "type": "sidebar-main" | "top-nav-main" | "full-width" | "split",
    "regions": [
      {
        "id": "header",
        "position": "top",
        "height": "64px",
        "components": ["logo", "nav-links", "user-menu"]
      },
      // ...
    ]
  },

  "components": [
    {
      "id": "stat-card-1",
      "type": "stat-card",
      "region": "main",
      "props": {
        "title": "Total Revenue",
        "value": "$45,231",
        "trend": "+12.5%"
      }
    },
    // ...
  ],

  "colorPalette": {
    "primary": "#3b82f6",
    "secondary": "#64748b",
    "background": "#ffffff",
    "surface": "#f8fafc",
    "text": "#0f172a",
    "success": "#22c55e",
    "warning": "#f59e0b",
    "error": "#ef4444"
  },

  "typography": {
    "headings": { "family": "Inter", "weight": 700 },
    "body": { "family": "Inter", "weight": 400 },
    "sizes": {
      "h1": "2.25rem",
      "h2": "1.5rem",
      "body": "1rem",
      "small": "0.875rem"
    }
  },

  "spacing": {
    "unit": 4,
    "containerPadding": 24,
    "cardPadding": 16,
    "gap": 16
  },

  "pages": [
    {
      "id": "dashboard",
      "route": "/",
      "title": "Dashboard",
      "layout": "sidebar-main",
      "sections": ["stats-row", "charts-area", "recent-activity"]
    }
  ],

  "stateFlows": [
    {
      "id": "date-range-filter",
      "trigger": "user clicks date picker",
      "states": ["closed", "open", "selecting", "applied"],
      "affectsComponents": ["stat-cards", "charts"]
    }
  ]
}

RULES:
1. Extract ACTUAL colors from the image using hex values
2. Identify ALL visible components and their approximate positions
3. Infer reasonable state flows from interactive elements
4. Use semantic component names (stat-card, data-table, line-chart)
5. Note any patterns or repeated elements
`;
```

### 4.2 DesignSpec Schema

```typescript
// packages/types/src/design-spec.ts

export interface DesignSpec {
  meta: {
    id: string;
    name: string;
    description: string;
    sourceImage: string;      // path to reference image
    createdAt: string;
    aesthetic: string;        // which preset was used
  };

  layout: {
    type: 'sidebar-main' | 'top-nav-main' | 'full-width' | 'split' | 'dashboard-grid';
    regions: LayoutRegion[];
  };

  components: ComponentSpec[];

  theme: {
    colors: ColorPalette;
    typography: TypographySpec;
    spacing: SpacingScale;
    borderRadius: string;
    shadows: Record<string, string>;
  };

  pages: PageSpec[];

  stateFlows: StateFlow[];

  scaffold: {
    framework: 'react' | 'vue' | 'svelte';
    styling: 'tailwind' | 'css-modules' | 'styled-components';
    stateManagement: 'zustand' | 'redux' | 'context' | 'none';
  };
}

export interface LayoutRegion {
  id: string;
  position: 'top' | 'left' | 'right' | 'bottom' | 'center';
  size: string;  // "64px" | "280px" | "1fr"
  components: string[];  // component IDs
}

export interface ComponentSpec {
  id: string;
  type: string;  // "stat-card" | "data-table" | "line-chart" | etc.
  region: string;
  props: Record<string, unknown>;
  variants?: string[];
  interactions?: string[];
}

export interface PageSpec {
  id: string;
  route: string;
  title: string;
  layout: string;
  sections: string[];
  components: string[];
}

export interface StateFlow {
  id: string;
  trigger: string;
  states: string[];
  affectsComponents: string[];
}
```

---

## 5. Project Scaffolding

### 5.1 Scaffold Structure

```
packages/{project-name}/
├── design-spec.json          # Full DesignSpec
├── reference.png             # Selected design image
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── src/
│   ├── main.tsx
│   ├── App.tsx               # Root with layout
│   ├── components/
│   │   ├── index.ts          # Barrel export
│   │   ├── StatCard.tsx      # Stubbed from spec
│   │   ├── DataTable.tsx
│   │   ├── LineChart.tsx
│   │   └── ...
│   ├── pages/
│   │   ├── Dashboard.tsx
│   │   └── ...
│   ├── layouts/
│   │   └── SidebarLayout.tsx
│   ├── styles/
│   │   ├── tokens.css        # CSS custom properties from palette
│   │   ├── globals.css
│   │   └── theme.ts          # Theme object for JS access
│   └── store/
│       └── index.ts          # State management setup
└── README.md                 # Design decisions + next steps
```

### 5.2 Token Generation

```typescript
function generateCSSTokens(spec: DesignSpec): string {
  const { colors, typography, spacing } = spec.theme;

  return `
:root {
  /* Colors */
  --color-primary: ${colors.primary};
  --color-secondary: ${colors.secondary};
  --color-background: ${colors.background};
  --color-surface: ${colors.surface};
  --color-text: ${colors.text};
  --color-text-muted: ${colors.textMuted ?? colors.secondary};
  --color-success: ${colors.success ?? '#22c55e'};
  --color-warning: ${colors.warning ?? '#f59e0b'};
  --color-error: ${colors.error ?? '#ef4444'};

  /* Typography */
  --font-heading: ${typography.headings};
  --font-body: ${typography.body};
  --font-mono: ${typography.mono};

  /* Spacing */
  --space-1: ${spacing.unit}px;
  --space-2: ${spacing.unit * 2}px;
  --space-3: ${spacing.unit * 3}px;
  --space-4: ${spacing.unit * 4}px;
  --space-6: ${spacing.unit * 6}px;
  --space-8: ${spacing.unit * 8}px;

  /* Layout */
  --container-padding: ${spacing.containerPadding}px;
  --card-padding: ${spacing.cardPadding}px;
  --gap: ${spacing.gap}px;

  /* Borders */
  --radius: ${spec.theme.borderRadius};
}
  `.trim();
}
```

---

## 6. Skill Definition

### 6.1 SKILL.md

```yaml
---
name: design-fork
description: Generate N divergent UI designs, select favorites, scaffold project
allowed-tools: Bash, Read, Write, Glob, Grep
model: inherit
enabled: true
tags: [design, frontend, prototyping]
---

## Design Fork Skill

You are a UI/UX design exploration assistant. Your job is to help users explore multiple design directions quickly and then scaffold their chosen direction into a project.

### Phase 1: Configuration

When the user invokes /design-fork with a description:

1. Ask how many design directions to generate (3, 5, or 10)
2. Ask for display preference (tmux grid or browser gallery)
3. Confirm before proceeding

### Phase 2: Image Generation

Generate N images using the image-gen tool with:
- Different aesthetic presets for each
- Consistent color palette (chosen or generated)
- JSON-structured layout prompts for machine-readable output
- Temperature scaled by N (lower N = lower temp)

### Phase 3: Display & Selection

Display all generated images and prompt user to select 1-3 favorites.

### Phase 4: Deconstruction

For each selected design:
1. Use vision to analyze the image
2. Extract: layout structure, components, colors, typography
3. Generate DesignSpec JSON

### Phase 5: Scaffold

Create project folder with:
- design-spec.json
- reference image
- Component stubs
- CSS tokens
- Basic routing

### Available Aesthetics

1. Minimal Monochrome - Ultra-clean, whitespace-heavy
2. Dark Glassmorphism - Frosted glass, neon accents
3. Neobrutalism - Bold borders, harsh shadows
4. Soft Gradients - Gentle transitions, rounded
5. Dense Data - Terminal-inspired, compact
6. Editorial - Magazine-style, strong typography
7. Retro Futurism - CRT aesthetic, vintage sci-fi
8. Corporate Clean - Enterprise-safe, blue/gray
9. Playful Bold - Vibrant, bouncy, friendly
10. Luxury Dark - Premium, gold accents
```

---

## 7. Implementation Order

### Phase 1: Core Infrastructure
- [ ] Image generation tool (Replicate/Flux integration)
- [ ] Design prompt builder with aesthetic presets
- [ ] Basic skill SKILL.md

### Phase 2: Display
- [ ] Browser gallery server (simpler, works everywhere)
- [ ] tmux grid display (optional, for power users)
- [ ] Selection handling

### Phase 3: Deconstruction
- [ ] Vision-based spec extraction
- [ ] DesignSpec schema validation (Zod)
- [ ] Color/typography extraction

### Phase 4: Scaffolding
- [ ] Project folder generation
- [ ] Component stub generation
- [ ] CSS token generation

### Phase 5: Polish
- [ ] Temperature scaling by N
- [ ] Error handling and retries
- [ ] Progress indicators

---

## 8. Cost Analysis

| Step | Cost (N=10) |
|------|-------------|
| Image generation | $0.15 (10 × $0.015) |
| Vision deconstruction (1-3 selected) | $0.02-0.06 |
| **Total per session** | **~$0.20** |

5 design exploration sessions for $1.

---

## 9. File Changes Summary

| File | Purpose | LOC |
|------|---------|-----|
| `packages/tools/src/builtins/image-gen.ts` | Flux Schnell API wrapper | ~80 |
| `packages/tools/src/builtins/design-gallery.ts` | Browser gallery server | ~120 |
| `packages/tui/utils/design-display.ts` | tmux grid display | ~100 |
| `config/skills/design-fork/SKILL.md` | Skill definition | ~150 |
| `config/design-fork/aesthetics.ts` | Aesthetic presets | ~200 |
| `config/design-fork/palettes.ts` | Color palettes | ~100 |
| `packages/types/src/design-spec.ts` | DesignSpec schema | ~120 |
| `packages/tools/src/builtins/design-scaffold.ts` | Project generation | ~200 |

**Total: ~1070 lines**

---

## 10. Example Session

```
> /design-fork "analytics dashboard for developer productivity metrics"

How many design directions would you like to explore?
  [3] Focused (0.85 temp) - I have a clear vision
  [5] Moderate (0.95 temp) - Some exploration
  [10] Exploratory (1.05 temp) - Show me everything

> 5

Display mode?
  [tmux] Show in terminal grid (requires kitty/iTerm2 graphics)
  [browser] Open gallery in browser

> browser

Generating 5 design concepts...
  [1/5] Minimal Monochrome ████████████████████ Done
  [2/5] Dark Glassmorphism ████████████████████ Done
  [3/5] Dense Data         ████████████████████ Done
  [4/5] Corporate Clean    ████████████████████ Done
  [5/5] Editorial          ████████████████████ Done

Opening gallery at http://localhost:3333

[User selects #2 and #5 in browser]

Selection received: [2, 5]

Analyzing design #2 (Dark Glassmorphism)...
  - Layout: sidebar-main with top header
  - Components: 4 stat cards, 2 line charts, 1 data table
  - Colors: #09090b background, #8b5cf6 primary
  - Typography: Inter for body, JetBrains Mono for data

Analyzing design #5 (Editorial)...
  - Layout: full-width with section breaks
  - Components: hero metrics, feature cards, activity timeline
  - Colors: #ffffff background, #0f172a text
  - Typography: Playfair Display headings, Source Sans body

Which design should I scaffold?
  [2] Dark Glassmorphism
  [5] Editorial

> 2

Creating project at packages/dev-metrics-dashboard/...
  ✓ design-spec.json
  ✓ reference.png
  ✓ package.json
  ✓ src/components/ (7 components)
  ✓ src/pages/Dashboard.tsx
  ✓ src/styles/tokens.css
  ✓ README.md

Done! Run `cd packages/dev-metrics-dashboard && bun dev` to start.
```
