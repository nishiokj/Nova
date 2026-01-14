#!/usr/bin/env bun
/**
 * Design Gallery CLI for design-fork skill.
 *
 * Starts a browser-based gallery for viewing and selecting design concepts.
 *
 * Usage:
 *   bun run scripts/gallery.ts --images '[{"path":"/tmp/design-1.png","label":"1","aesthetic":"dark-glass"}]'
 *   bun run scripts/gallery.ts --dir /tmp/design-fork --max 3
 *
 * Output: JSON with selected image indices.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { exec } from 'child_process';
import { platform } from 'os';
import { join } from 'path';
import { parseArgs } from 'util';

interface GalleryImage {
  path: string;
  label: string;
  aesthetic: string;
}

interface Output {
  success: boolean;
  selectedIndices?: number[];
  selectedImages?: GalleryImage[];
  error?: string;
}

function generateGalleryHTML(images: GalleryImage[], maxSelections: number): string {
  const columns = images.length <= 5 ? images.length : 5;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Design Fork - Select Favorites</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0a;
      color: #fafafa;
      padding: 2rem;
      min-height: 100vh;
    }

    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
    .subtitle { color: #a1a1aa; margin-bottom: 2rem; }

    .grid {
      display: grid;
      grid-template-columns: repeat(${columns}, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }

    @media (max-width: 1200px) { .grid { grid-template-columns: repeat(3, 1fr); } }
    @media (max-width: 768px) { .grid { grid-template-columns: repeat(2, 1fr); } }

    .card {
      background: #18181b;
      border: 2px solid transparent;
      border-radius: 12px;
      overflow: hidden;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .card:hover { border-color: #3f3f46; transform: translateY(-2px); }
    .card.selected { border-color: #22c55e; box-shadow: 0 0 24px rgba(34, 197, 94, 0.3); }

    .card img { width: 100%; aspect-ratio: 4/3; object-fit: cover; display: block; }

    .card-info {
      padding: 0.75rem 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .card-label { font-weight: 600; font-size: 1.1rem; }
    .card-aesthetic { font-size: 0.75rem; color: #71717a; text-transform: uppercase; letter-spacing: 0.05em; }

    .actions {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 1.5rem 2rem;
      background: linear-gradient(transparent, #0a0a0a 20%);
      display: flex;
      justify-content: center;
      gap: 1rem;
    }

    button {
      padding: 0.875rem 2rem;
      font-size: 1rem;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-primary { background: #22c55e; color: #052e16; }
    .btn-primary:hover:not(:disabled) { background: #16a34a; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

    .btn-secondary { background: #27272a; color: #fafafa; }
    .btn-secondary:hover { background: #3f3f46; }

    .selection-count { color: #a1a1aa; font-size: 0.875rem; }

    .success-message {
      position: fixed;
      inset: 0;
      background: #0a0a0a;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1rem;
    }

    .success-message h2 { font-size: 1.5rem; color: #22c55e; }
    .success-message p { color: #71717a; }
  </style>
</head>
<body>
  <div id="app">
    <h1>Select Your Favorite Design(s)</h1>
    <p class="subtitle">Click to select up to ${maxSelections} designs, then confirm your selection.</p>

    <div class="grid">
      ${images
        .map(
          (img, i) => `
        <div class="card" data-index="${i}" onclick="toggle(${i})">
          <img src="/image/${i}" alt="Design ${i + 1}" loading="lazy">
          <div class="card-info">
            <span class="card-label">[${i + 1}]</span>
            <span class="card-aesthetic">${img.aesthetic}</span>
          </div>
        </div>
      `
        )
        .join('')}
    </div>

    <div class="actions">
      <span class="selection-count" id="count">0 / ${maxSelections} selected</span>
      <button class="btn-secondary" onclick="clearAll()">Clear</button>
      <button class="btn-primary" onclick="confirm()" id="confirmBtn" disabled>
        Confirm Selection
      </button>
    </div>
  </div>

  <script>
    const selected = new Set();
    const maxSelections = ${maxSelections};

    function toggle(idx) {
      const card = document.querySelector(\`[data-index="\${idx}"]\`);
      if (selected.has(idx)) {
        selected.delete(idx);
        card.classList.remove('selected');
      } else if (selected.size < maxSelections) {
        selected.add(idx);
        card.classList.add('selected');
      }
      updateUI();
    }

    function clearAll() {
      selected.clear();
      document.querySelectorAll('.card').forEach(c => c.classList.remove('selected'));
      updateUI();
    }

    function updateUI() {
      const btn = document.getElementById('confirmBtn');
      const count = document.getElementById('count');
      btn.disabled = selected.size === 0;
      count.textContent = \`\${selected.size} / \${maxSelections} selected\`;
    }

    async function confirm() {
      const btn = document.getElementById('confirmBtn');
      btn.disabled = true;
      btn.textContent = 'Sending...';

      try {
        const response = await fetch('/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ indices: [...selected].sort((a, b) => a - b) })
        });

        if (response.ok) {
          document.getElementById('app').innerHTML = \`
            <div class="success-message">
              <h2>Selection Received!</h2>
              <p>Return to your terminal to continue.</p>
            </div>
          \`;
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Confirm Selection';
        alert('Failed to submit selection. Please try again.');
      }
    }
  </script>
</body>
</html>`;
}

function openBrowser(url: string): void {
  const cmd =
    platform() === 'darwin'
      ? `open "${url}"`
      : platform() === 'win32'
        ? `start "${url}"`
        : `xdg-open "${url}"`;

  exec(cmd, (err) => {
    if (err) {
      console.error(`Failed to open browser: ${err.message}`);
    }
  });
}

function startGalleryServer(
  images: GalleryImage[],
  port: number,
  maxSelections: number,
  autoOpen: boolean
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    let server: Server;

    const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';

      // Serve main page
      if (url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(generateGalleryHTML(images, maxSelections));
        return;
      }

      // Serve images
      if (url.startsWith('/image/')) {
        const idx = parseInt(url.split('/')[2], 10);
        if (isNaN(idx) || idx < 0 || idx >= images.length) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const imagePath = images[idx].path;
        if (!existsSync(imagePath)) {
          res.writeHead(404);
          res.end('Image not found');
          return;
        }

        try {
          const imageData = readFileSync(imagePath);
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(imageData);
        } catch {
          res.writeHead(500);
          res.end('Failed to read image');
        }
        return;
      }

      // Handle selection
      if (url === '/select' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const { indices } = JSON.parse(body);
            res.writeHead(200);
            res.end('OK');

            // Close server and resolve
            server.close(() => {
              resolve(indices);
            });
          } catch {
            res.writeHead(400);
            res.end('Invalid request');
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    };

    server = createServer(handleRequest);

    server.on('error', (err) => {
      reject(err);
    });

    server.listen(port, () => {
      const galleryUrl = `http://localhost:${port}`;
      console.error(`Gallery: ${galleryUrl}`);

      if (autoOpen) {
        openBrowser(galleryUrl);
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Gallery selection timed out'));
    }, 5 * 60 * 1000);
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      images: { type: 'string', short: 'i' },
      dir: { type: 'string', short: 'd' },
      port: { type: 'string', short: 'p', default: '3333' },
      max: { type: 'string', short: 'm', default: '3' },
      'no-open': { type: 'boolean', default: false },
    },
    strict: true,
  });

  let images: GalleryImage[] = [];

  // Parse images from JSON or directory
  if (values.images) {
    try {
      images = JSON.parse(values.images);
    } catch {
      const output: Output = { success: false, error: 'Invalid --images JSON' };
      console.log(JSON.stringify(output));
      process.exit(1);
    }
  } else if (values.dir) {
    // Scan directory for PNG files
    const dir = values.dir;
    if (!existsSync(dir)) {
      const output: Output = { success: false, error: `Directory not found: ${dir}` };
      console.log(JSON.stringify(output));
      process.exit(1);
    }

    const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    images = files.map((f, i) => ({
      path: join(dir, f),
      label: `${i + 1}`,
      aesthetic: f.replace('.png', '').replace(/^design-\d+-/, ''),
    }));
  } else {
    const output: Output = { success: false, error: 'Missing --images or --dir argument' };
    console.log(JSON.stringify(output));
    process.exit(1);
  }

  if (images.length === 0) {
    const output: Output = { success: false, error: 'No images to display' };
    console.log(JSON.stringify(output));
    process.exit(1);
  }

  const port = parseInt(values.port ?? '3333', 10);
  const maxSelections = parseInt(values.max ?? '3', 10);
  const autoOpen = !values['no-open'];

  try {
    const selectedIndices = await startGalleryServer(images, port, maxSelections, autoOpen);

    const output: Output = {
      success: true,
      selectedIndices,
      selectedImages: selectedIndices.map((i) => images[i]),
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    const output: Output = { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    console.log(JSON.stringify(output));
    process.exit(1);
  }
}

main().catch((error) => {
  const output: Output = { success: false, error: error.message };
  console.log(JSON.stringify(output));
  process.exit(1);
});
