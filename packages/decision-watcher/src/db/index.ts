/**
 * Decision Database Implementations
 *
 * Provides in-memory and file-based storage for decisions and preferences.
 */

import type {
  Decision,
  DecisionEntry,
  DecisionDatabase,
  DecisionCategory,
  DecisionScope,
} from '../types.js';

// ============================================
// IN-MEMORY DATABASE
// ============================================

/**
 * In-memory implementation of DecisionDatabase.
 * Fast for development and testing.
 */
export class InMemoryDecisionDatabase implements DecisionDatabase {
  private entries: Map<string, DecisionEntry> = new Map();

  constructor(entries: DecisionEntry[] = []) {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
  }

  async search(
    query: string,
    options?: {
      category?: DecisionCategory;
      scope?: DecisionScope;
      limit?: number;
    }
  ): Promise<DecisionEntry[]> {
    const normalizedQuery = query.toLowerCase();
    const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 2);

    let results = Array.from(this.entries.values());

    // Filter by category if specified
    if (options?.category) {
      results = results.filter(e => e.category === options.category);
    }

    // Filter by scope if specified (only Decision has scope)
    if (options?.scope) {
      results = results.filter(e => 'scope' in e && e.scope === options.scope);
    }

    // Score and sort by relevance
    const scored = results.map(entry => {
      const score = this.calculateRelevance(entry, normalizedQuery, queryWords);
      return { entry, score };
    });

    const filtered = scored.filter(s => s.score > 0);
    filtered.sort((a, b) => b.score - a.score);

    // Apply limit
    if (options?.limit) {
      return filtered.slice(0, options.limit).map(s => s.entry);
    }

    return filtered.map(s => s.entry);
  }

  async get(id: string): Promise<DecisionEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async getAll(): Promise<DecisionEntry[]> {
    return Array.from(this.entries.values());
  }

  async upsert(entry: DecisionEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  /**
   * Calculate relevance score for an entry against a query.
   * Higher is more relevant.
   */
  private calculateRelevance(
    entry: DecisionEntry,
    normalizedQuery: string,
    queryWords: string[]
  ): number {
    // Only Decision has questionPattern and appliesTo
    const isDec = 'decision' in entry;

    let score = 0;

    // Check question pattern / decision text
    const targetText = isDec ? entry.decision : entry.preference;
    const lowerTarget = targetText.toLowerCase();

    // Exact phrase match in question pattern (Decision only)
    if (isDec && entry.questionPattern) {
      const patternLower = entry.questionPattern.toLowerCase();
      if (patternLower.includes(normalizedQuery)) {
        score += 50;
      }
      // If query is contained in pattern
      if (normalizedQuery.includes(patternLower) || patternLower.includes(normalizedQuery)) {
        score += 30;
      }
    }

    // Keyword matches
    for (const keyword of entry.keywords) {
      const kwLower = keyword.toLowerCase();
      if (normalizedQuery.includes(kwLower)) {
        score += 10;
      }
    }

    // Word-level matching in target text
    for (const word of queryWords) {
      if (lowerTarget.includes(word)) {
        score += 5;
      }
    }

    return score;
  }

  /**
   * Add entries in bulk.
   */
  async upsertMany(entries: DecisionEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.upsert(entry);
    }
  }

  /**
   * Clear all entries.
   */
  async clear(): Promise<void> {
    this.entries.clear();
  }
}

// ============================================
// FILE-BASED DATABASE (Future)
// ============================================

/**
 * File-based implementation of DecisionDatabase.
 * Persists decisions to a JSON file.
 */
export class FileDecisionDatabase implements DecisionDatabase {
  private db: InMemoryDecisionDatabase;
  private filepath: string;
  private loaded: boolean = false;

  constructor(filepath: string, autoLoad: boolean = true) {
    this.filepath = filepath;
    this.db = new InMemoryDecisionDatabase();

    // Auto-load on construction if requested
    if (autoLoad) {
      // Load asynchronously but don't await - allows DB to be used immediately
      void this.load().catch(err => {
        // If file doesn't exist yet, that's fine - it will be created on first save
        if (!err.message.includes('ENOENT')) {
          console.error(`[FileDecisionDatabase] Failed to load from ${filepath}:`, err);
        }
      });
    }
  }

  async search(
    query: string,
    options?: {
      category?: DecisionCategory;
      scope?: DecisionScope;
      limit?: number;
    }
  ): Promise<DecisionEntry[]> {
    return this.db.search(query, options);
  }

  async get(id: string): Promise<DecisionEntry | null> {
    return this.db.get(id);
  }

  async getAll(): Promise<DecisionEntry[]> {
    return this.db.getAll();
  }

  async upsert(entry: DecisionEntry): Promise<void> {
    await this.db.upsert(entry);
    await this.save();
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(id);
    await this.save();
  }

  /**
   * Load entries from file.
   * Populates the in-memory database with entries from the JSON file.
   * If the file doesn't exist, clears the database (starts fresh).
   */
  async load(): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const data = await fs.readFile(this.filepath, 'utf-8');

      // Parse JSON and populate database
      const entries = JSON.parse(data) as DecisionEntry[];

      // Clear existing entries and reload
      await this.db.clear();

      // Upsert all entries
      await this.db.upsertMany(entries);

      this.loaded = true;
    } catch (err) {
      // If file doesn't exist, that's okay - start with empty database
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        this.db.clear();
        this.loaded = true;
        return;
      }

      // Re-throw other errors
      throw err;
    }
  }

  /**
   * Save entries to file.
   * Serializes all entries from the in-memory database to JSON.
   */
  async save(): Promise<void> {
    try {
      const fs = await import('fs/promises');

      // Get all entries from in-memory database
      const entries = await this.db.getAll();

      // Ensure directory exists
      await fs.mkdir(this.filepath.split('/').slice(0, -1).join('/'), { recursive: true });

      // Write to file with atomic write pattern (write to temp, then rename)
      const tempPath = `${this.filepath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(entries, null, 2), 'utf-8');
      await fs.rename(tempPath, this.filepath);

      this.loaded = true;
    } catch (err) {
      console.error(`[FileDecisionDatabase] Failed to save to ${this.filepath}:`, err);
      throw err;
    }
  }

  /**
   * Clear all entries.
   */
  async clear(): Promise<void> {
    await this.db.clear();
    await this.save();
  }
}

// ============================================
// FACTORY FUNCTIONS
// ============================================

/**
 * Create an in-memory decision database with optional initial entries.
 */
export function createInMemoryDatabase(entries?: DecisionEntry[]): InMemoryDecisionDatabase {
  return new InMemoryDecisionDatabase(entries);
}

/**
 * Create a file-based decision database.
 */
export function createFileDatabase(filepath: string): FileDecisionDatabase {
  return new FileDecisionDatabase(filepath);
}
