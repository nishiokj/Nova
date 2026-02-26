#!/usr/bin/env bun
/**
 * Image Generation CLI for design-fork skill.
 *
 * Usage:
 *   bun run scripts/image-gen.ts --prompt "..." --aesthetic "dark-glass" --output /tmp/designs/
 *
 * Output: JSON with generated image paths and metadata.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { parseArgs } from 'util';
import { generateImage, downloadImage } from '../lib/replicate.js';
import { getAesthetic, selectAesthetics, getTemperatureForN } from '../lib/aesthetics.js';
import { getPalettesForAesthetic, getRandomTypography } from '../lib/palettes.js';
import { getProviderKey } from '../lib/providers.js';

interface GeneratedImage {
  index: number;
  path: string;
  aesthetic: string;
  palette: string;
  prompt: string;
}

interface Output {
  success: boolean;
  images?: GeneratedImage[];
  outputDir?: string;
  error?: string;
}

function buildPrompt(
  description: string,
  aestheticId: string,
  aestheticDesc: string,
  modifiers: string[],
  palette: { primary: string; secondary: string; background: string; surface: string; text: string },
  typography: { headingFont: string; bodyFont: string }
): string {
  return `UI design mockup, high fidelity wireframe style, clean vector aesthetic.

APPLICATION: ${description}

COLOR PALETTE:
- Primary: ${palette.primary}
- Secondary: ${palette.secondary}
- Background: ${palette.background}
- Surface: ${palette.surface}
- Text: ${palette.text}

TYPOGRAPHY:
- Headings: ${typography.headingFont}
- Body: ${typography.bodyFont}

AESTHETIC DIRECTION:
${aestheticDesc}

REQUIREMENTS:
- Clear visual hierarchy with labeled sections
- Distinguishable UI components (buttons, inputs, cards)
- Realistic placeholder text and data
- Professional, production-ready appearance
${modifiers.map((m) => `- ${m}`).join('\n')}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      prompt: { type: 'string', short: 'p' },
      aesthetic: { type: 'string', short: 'a' },
      count: { type: 'string', short: 'n', default: '1' },
      output: { type: 'string', short: 'o', default: '/tmp/design-fork' },
      width: { type: 'string', default: '1024' },
      height: { type: 'string', default: '768' },
    },
    strict: true,
  });

  const apiKey = getProviderKey('replicate');
  if (!apiKey) {
    const output: Output = {
      success: false,
      error: 'Replicate API key not configured. Run /providers to add your Replicate API key.',
    };
    console.log(JSON.stringify(output));
    process.exit(1);
  }

  if (!values.prompt) {
    const output: Output = { success: false, error: 'Missing required --prompt argument' };
    console.log(JSON.stringify(output));
    process.exit(1);
  }

  const description = values.prompt;
  const count = parseInt(values.count ?? '1', 10);
  const outputDir = values.output ?? '/tmp/design-fork';
  const width = parseInt(values.width ?? '1024', 10);
  const height = parseInt(values.height ?? '768', 10);

  // Create output directory
  await mkdir(outputDir, { recursive: true });

  // If count is 0, this is just a pre-flight check to verify the API key is configured
  if (count === 0) {
    const output: Output = {
      success: true,
      images: [],
      outputDir,
    };
    console.log(JSON.stringify(output));
    return;
  }

  // Select aesthetics
  let aesthetics;
  if (values.aesthetic) {
    const single = getAesthetic(values.aesthetic);
    if (!single) {
      const output: Output = { success: false, error: `Unknown aesthetic: ${values.aesthetic}` };
      console.log(JSON.stringify(output));
      process.exit(1);
    }
    aesthetics = [single];
  } else {
    aesthetics = selectAesthetics(count);
  }

  const generatedImages: GeneratedImage[] = [];

  // Generate images
  for (let i = 0; i < Math.min(count, aesthetics.length); i++) {
    // Add delay between requests to respect rate limits (15 seconds per request for < $5 credit tier)
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 15000));
    }

    const aesthetic = aesthetics[i];
    const palettes = getPalettesForAesthetic(aesthetic.id);
    const palette = palettes[0];
    const typography = getRandomTypography();
    const temperature = getTemperatureForN(count, aesthetic.temperature);

    const prompt = buildPrompt(
      description,
      aesthetic.id,
      aesthetic.description,
      aesthetic.modifiers,
      palette,
      typography
    );

    // Generate with a seed for reproducibility within session
    const seed = Math.floor(Math.random() * 1000000);

    const result = await generateImage({
      prompt,
      width,
      height,
      seed,
      apiKey,
    });

    if (!result.success) {
      console.error(`[${i + 1}/${count}] Failed: ${result.error}`);
      continue;
    }

    if (!result.url) {
      console.error(`[${i + 1}/${count}] Failed: No URL returned from image generation`);
      console.error(`Prediction ID: ${result.predictionId}`);
      continue;
    }

    console.error(`[${i + 1}/${count}] Image URL: ${result.url}`);

    // Download and save locally
    let imageBuffer;
    try {
      imageBuffer = await downloadImage(result.url);
    } catch (error) {
      console.error(`[${i + 1}/${count}] Failed to download image: ${error}`);
      console.error(`URL was: ${result.url}`);
      continue;
    }
    const filename = `design-${i + 1}-${aesthetic.id}.png`;
    const localPath = join(outputDir, filename);
    await writeFile(localPath, imageBuffer);

    generatedImages.push({
      index: i,
      path: localPath,
      aesthetic: aesthetic.id,
      palette: palette.id,
      prompt,
    });

    console.error(`[${i + 1}/${count}] Generated: ${aesthetic.name} -> ${localPath}`);
  }

  const output: Output = {
    success: generatedImages.length > 0,
    images: generatedImages,
    outputDir,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  const output: Output = { success: false, error: error.message };
  console.log(JSON.stringify(output));
  process.exit(1);
});
