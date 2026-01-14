/**
 * Replicate API client for Flux Schnell image generation.
 */

const REPLICATE_API_BASE = 'https://api.replicate.com/v1';
const FLUX_MODEL = 'black-forest-labs/flux-schnell';
const POLL_INTERVAL_MS = 500;
const MAX_POLL_ATTEMPTS = 120; // 60 seconds max

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string[];
  error?: string;
}

export interface ImageGenOptions {
  prompt: string;
  width?: number;
  height?: number;
  seed?: number;
  apiKey: string;
}

export interface ImageGenResult {
  success: boolean;
  url?: string;
  predictionId?: string;
  error?: string;
}

/**
 * Create a prediction on Replicate.
 */
async function createPrediction(options: ImageGenOptions): Promise<ReplicatePrediction> {
  const { prompt, width = 1024, height = 768, seed, apiKey } = options;

  const response = await fetch(`${REPLICATE_API_BASE}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      version: FLUX_MODEL,
      input: {
        prompt,
        width,
        height,
        num_outputs: 1,
        output_format: 'png',
        ...(seed !== undefined && { seed }),
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Replicate API error: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Poll prediction status until complete.
 */
async function pollPrediction(predictionId: string, apiKey: string): Promise<ReplicatePrediction> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const response = await fetch(`${REPLICATE_API_BASE}/predictions/${predictionId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to poll prediction: ${response.status}`);
    }

    const prediction: ReplicatePrediction = await response.json();

    if (prediction.status === 'succeeded') {
      return prediction;
    }

    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      throw new Error(prediction.error ?? 'Prediction failed');
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error('Prediction timed out');
}

/**
 * Generate an image using Flux Schnell.
 */
export async function generateImage(options: ImageGenOptions): Promise<ImageGenResult> {
  try {
    const prediction = await createPrediction(options);
    const result = await pollPrediction(prediction.id, options.apiKey);

    if (!result.output || result.output.length === 0) {
      return { success: false, error: 'No output from image generation' };
    }

    return {
      success: true,
      url: result.output[0],
      predictionId: prediction.id,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Download an image from URL to a local buffer.
 */
export async function downloadImage(url: string): Promise<Buffer> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
