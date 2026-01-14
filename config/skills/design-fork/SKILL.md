---
name: design-fork
description: Generate N divergent UI designs as images, select favorites in browser, scaffold chosen design into a React project. Use when user wants to explore visual design directions.
enabled: true
tags: [design, frontend, prototyping, ui, image-generation]
---

# Design Fork Skill

You are a UI/UX design exploration assistant. Your job is to help users explore multiple visual design directions quickly and then scaffold their chosen direction into a working project.

## Core Principle

Use **image generation for visual entropy** (Flux Schnell produces diverse mockups), not LLM code generation (which converges to similar patterns). Only deconstruct and scaffold after the user selects their favorites - this saves compute and respects user choice.

## Prerequisites

The user must have their Replicate API key configured via `/providers`. The scripts automatically read from the provider store.

**Pre-flight check**: When the user invokes `/design-fork`, run the image-gen script with `--help` or a minimal prompt to verify the key is configured:

```bash
cd config/skills/design-fork && bun run scripts/image-gen.ts --prompt "test" --count 0
```

If it outputs `"error": "Replicate API key not configured..."`, tell the user:

> Your Replicate API key isn't configured. Run `/providers`, select Replicate, and paste your API key. You can get one at https://replicate.com/account/api-tokens

## Workflow

### Step 1: Configuration

When the user invokes `/design-fork` with a description, ask:

1. **How many design directions?**
   - **3** (Focused) - User has a clear vision
   - **5** (Moderate) - Some exploration
   - **10** (Exploratory) - Show me everything

2. **Confirm the design request** before generating.

### Step 2: Generate Images

Run the image generation script:

```bash
cd config/skills/design-fork && bun run scripts/image-gen.ts \
  --prompt "YOUR_DESCRIPTION_HERE" \
  --count 5 \
  --output /tmp/design-fork
```

The script outputs JSON with the generated image paths:

```json
{
  "success": true,
  "images": [
    { "index": 0, "path": "/tmp/design-fork/design-1-dark-glass.png", "aesthetic": "dark-glass" },
    { "index": 1, "path": "/tmp/design-fork/design-2-minimal-mono.png", "aesthetic": "minimal-mono" }
  ],
  "outputDir": "/tmp/design-fork"
}
```

### Step 3: Display Gallery

Open the browser gallery for selection:

```bash
cd config/skills/design-fork && bun run scripts/gallery.ts \
  --dir /tmp/design-fork \
  --max 3
```

This opens a browser at `http://localhost:3333` where the user can click to select their favorite designs. The script blocks until the user confirms, then outputs:

```json
{
  "success": true,
  "selectedIndices": [1, 3],
  "selectedImages": [
    { "path": "/tmp/design-fork/design-2-minimal-mono.png", "aesthetic": "minimal-mono" },
    { "path": "/tmp/design-fork/design-4-neobrutalism.png", "aesthetic": "neobrutalism" }
  ]
}
```

### Step 4: Vision Analysis

For the selected design(s), use your vision capabilities to analyze the image and extract:

1. **Layout structure**: sidebar-main, top-nav-main, full-width, dashboard-grid
2. **Components**: buttons, cards, inputs, tables, charts visible in the mockup
3. **Color palette**: Extract approximate hex values from the image
4. **Typography style**: Serif, sans-serif, monospace tendencies
5. **Spacing patterns**: Compact vs generous

### Step 5: Scaffold Project

Generate the project using the scaffold script:

```bash
cd config/skills/design-fork && bun run scripts/scaffold.ts \
  --name "My Dashboard" \
  --aesthetic dark-glass \
  --palette zinc \
  --output packages/my-dashboard \
  --reference /tmp/design-fork/design-2-dark-glass.png
```

Or if you've created a design-spec.json from your vision analysis:

```bash
cd config/skills/design-fork && bun run scripts/scaffold.ts \
  --spec /tmp/design-fork/design-spec.json \
  --output packages/my-dashboard
```

The script outputs:

```json
{
  "success": true,
  "outputDir": "packages/my-dashboard",
  "files": [
    "packages/my-dashboard/package.json",
    "packages/my-dashboard/src/App.tsx",
    "packages/my-dashboard/src/styles/tokens.css"
  ]
}
```

### Step 6: Next Steps

Tell the user:

```
Project scaffolded! To start development:

cd packages/my-dashboard
bun install
bun dev

The reference image is saved at packages/my-dashboard/reference.png
Design tokens are in src/styles/tokens.css
```

## Available Aesthetics

The image generator selects from 10 divergent design directions:

| ID | Name | Description |
|----|------|-------------|
| minimal-mono | Minimal Monochrome | Ultra-clean, whitespace-heavy, single accent |
| dark-glass | Dark Glassmorphism | Frosted glass effects, neon accents |
| neobrutalism | Neobrutalism | Bold borders, harsh shadows, solid colors |
| soft-gradients | Soft Gradients | Gentle transitions, large border-radius |
| dense-data | Dense Data | Terminal-inspired, compact spacing |
| editorial | Editorial | Magazine-style, dramatic typography |
| retro-futurism | Retro Futurism | CRT aesthetic, amber/green on black |
| corporate-clean | Corporate Clean | Enterprise-safe, blue/gray palette |
| playful-bold | Playful Bold | Vibrant colors, bouncy shapes |
| luxury-dark | Luxury Dark | Premium feel, gold accents, serif headings |

## Cost Estimate

| Step | Cost |
|------|------|
| Image generation (10 images) | ~$0.15 |
| Vision analysis | ~$0.02-0.06 |
| **Total per session** | **~$0.20** |

## Tips

- **More N = More Exploration**: If unsure about direction, use 10. If you have a clear vision, use 3.
- **Save Compute**: Only selected designs get analyzed - unselected images are cheap.
- **Iterate**: Run multiple sessions to explore different directions.
- **Reference Image**: The scaffold saves the reference image for ongoing development.
