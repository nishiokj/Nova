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
  output?: string | string[];
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

  const requestBody = {
    version: 'prunaai/z-image-turbo',
    input: {
      prompt,
      width,
      height,
      num_outputs: 1,
      output_format: 'png',
      ...(seed !== undefined && { seed }),
    },
  };

  const response = await fetch(`${REPLICATE_API_BASE}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Replicate API error: ${response.status} - ${error}`);
  }

  const result = await response.json();
  console.error(`[replicate] Created prediction: ${result.id}`);
  return result;
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

    if (i % 10 === 0) {
      console.error(`[replicate] Polling ${predictionId}: status=${prediction.status}, attempt=${i+1}/${MAX_POLL_ATTEMPTS}`);
    }

    if (prediction.status === 'succeeded') {
      console.error(`[replicate] Prediction ${predictionId} succeeded`);
      console.error(`[replicate] Output: ${JSON.stringify(prediction.output)}`);
      return prediction;
    }

    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      console.error(`[replicate] Prediction ${predictionId} ${prediction.status}: ${prediction.error}`);
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

    if (!result.output) {
      return { success: false, error: 'No output from image generation' };
    }

    // Handle both string and array output formats
    let url: string;
    if (Array.isArray(result.output)) {
      if (result.output.length === 0) {
        return { success: false, error: 'No output from image generation' };
      }
      url = result.output[0];
    } else {
      url = result.output;
    }

    return {
      success: true,
      url,
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
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid image URL: URL is missing or not a string');
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
