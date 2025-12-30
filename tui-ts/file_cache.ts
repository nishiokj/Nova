import fs from "fs";
import path from "path";

const IGNORED_DIRS = new Set([
  "node_modules",
  "__pycache__",
  "venv",
  ".venv",
  "dist",
  "build",
  "site-packages",
  ".pytest_cache",
  ".claude",
  "logs",
  ".git",
  ".mypy_cache",
  ".ruff_cache",
  ".idea",
  ".vscode",
  "temp",
  ".egg-info",
  "htmlcov",
  ".tox",
  ".nox",
]);

const IGNORED_EXTENSIONS = new Set([
  ".pyc",
  ".pyo",
  ".so",
  ".dylib",
  ".dll",
  ".class",
  ".o",
]);

export class FileCache {
  private rootDir: string;
  private files: string[] = [];
  private lastUpdate = 0;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  async buildInitial(): Promise<void> {
    this.files = await this.scanFiles();
    this.lastUpdate = Date.now();
  }

  async refreshIfNeeded(minIntervalMs = 5000): Promise<void> {
    const now = Date.now();
    if (now - this.lastUpdate < minIntervalMs) {
      return;
    }

    this.files = await this.scanFiles();
    this.lastUpdate = now;
  }

  getFiles(): string[] {
    return [...this.files];
  }

  private async scanFiles(): Promise<string[]> {
    const results: string[] = [];

    const walk = async (dir: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (error) {
        return;
      }

      for (const entry of entries) {
        const name = entry.name;
        if (name.startsWith(".")) {
          continue;
        }

        const fullPath = path.join(dir, name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(name)) {
            continue;
          }
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(name);
          if (IGNORED_EXTENSIONS.has(ext)) {
            continue;
          }
          const relPath = path.relative(this.rootDir, fullPath);
          results.push(relPath.split(path.sep).join("/"));
        }
      }
    };

    await walk(this.rootDir);
    results.sort();
    return results;
  }
}

export function fuzzyMatch(query: string, candidates: string[], limit = 10): string[] {
  if (!query) {
    return [];
  }

  const q = query.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];

  for (const candidate of candidates) {
    const filename = path.basename(candidate).toLowerCase();
    const pathLower = candidate.toLowerCase();

    if (filename.startsWith(q)) {
      scored.push({ path: candidate, score: 1000 + q.length * 10 });
      continue;
    }

    if (filename.includes(q)) {
      const pos = filename.indexOf(q);
      scored.push({ path: candidate, score: 500 + q.length * 5 - pos });
      continue;
    }

    if (pathLower.includes(q)) {
      const pos = pathLower.indexOf(q);
      scored.push({ path: candidate, score: 100 + q.length * 2 - Math.floor(pos / 2) });
      continue;
    }

    const charScore = charSequenceScore(q, filename);
    if (charScore > 0) {
      scored.push({ path: candidate, score: charScore });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.path.localeCompare(b.path);
  });

  return scored.slice(0, limit).map((entry) => entry.path);
}

function charSequenceScore(query: string, text: string): number {
  let qi = 0;
  let ti = 0;
  let matches = 0;

  while (qi < query.length && ti < text.length) {
    if (query[qi] === text[ti]) {
      qi += 1;
      matches += 1;
    }
    ti += 1;
  }

  if (qi === query.length) {
    return matches * 10;
  }

  return 0;
}
