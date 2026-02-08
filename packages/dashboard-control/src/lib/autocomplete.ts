export interface AtMentionMatch {
  from: number;
  to: number;
  query: string;
}

const MENTION_BODY_RE = /^[A-Za-z0-9_./-]*$/;
const MENTION_BOUNDARY_RE = /[\s([{"'`]/;
const MARKDOWN_EXT_RE = /\.(md|markdown|mdx)$/i;
const SEGMENT_BOUNDARY_RE = /[\/._-]/;

/**
 * Finds an active @mention token ending at `cursor`.
 * Example: "open @src/App" -> query = "src/App"
 */
export function detectAtMention(text: string, cursor: number): AtMentionMatch | null {
  if (cursor < 0 || cursor > text.length) return null;

  let at = -1;
  for (let i = cursor - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '@') {
      at = i;
      break;
    }
    if (/\s/.test(ch)) break;
    if (!/[A-Za-z0-9_./-]/.test(ch)) return null;
  }
  if (at < 0) return null;

  const prev = at > 0 ? text[at - 1] : '';
  if (prev && !MENTION_BOUNDARY_RE.test(prev)) return null;

  const query = text.slice(at + 1, cursor);
  if (!MENTION_BODY_RE.test(query)) return null;

  return { from: at, to: cursor, query };
}

function stripMarkdownExtension(value: string): string {
  return value.replace(MARKDOWN_EXT_RE, '');
}

function subsequencePenalty(needle: string, haystack: string): number | null {
  if (!needle) return 0;
  let score = 0;
  let fromIndex = 0;
  let lastMatch = -1;

  for (let i = 0; i < needle.length; i += 1) {
    const ch = needle[i];
    const idx = haystack.indexOf(ch, fromIndex);
    if (idx < 0) return null;
    if (lastMatch < 0) {
      score += idx;
    } else {
      const gap = idx - lastMatch - 1;
      score += gap;
      if (gap === 0) score -= 1;
    }
    const prev = idx > 0 ? haystack[idx - 1] : '';
    if (!prev || SEGMENT_BOUNDARY_RE.test(prev)) score -= 2;
    lastMatch = idx;
    fromIndex = idx + 1;
  }

  score += Math.max(0, haystack.length - needle.length);
  return Math.max(0, score);
}

function startsWithAny(target: string, a: string, b: string): boolean {
  return target.startsWith(a) || target.startsWith(b);
}

function indexOfAny(target: string, a: string, b: string): number {
  const idxA = target.indexOf(a);
  const idxB = target.indexOf(b);
  if (idxA < 0) return idxB;
  if (idxB < 0) return idxA;
  return Math.min(idxA, idxB);
}

function scorePath(path: string, queryLowerRaw: string): number {
  const pathLower = path.toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = pathLower.split('/').filter(Boolean);
  const name = segments[segments.length - 1] ?? pathLower;
  const nameNoExt = stripMarkdownExtension(name);
  const pathNoExt = stripMarkdownExtension(pathLower);
  const hiddenPenalty = segments.some((segment) => segment.startsWith('.')) ? 120 : 0;

  const queryLower = queryLowerRaw.toLowerCase();
  if (!queryLower) {
    return 200 + (segments.length * 5) + (pathLower.length / 25) + hiddenPenalty;
  }

  const queryNoExt = stripMarkdownExtension(queryLower);
  let best = Number.POSITIVE_INFINITY;
  const consider = (score: number) => {
    if (score < best) best = score;
  };

  if (pathLower === queryLower || pathNoExt === queryLower || pathLower === queryNoExt || pathNoExt === queryNoExt) {
    consider(0);
  }
  if (name === queryLower || nameNoExt === queryLower || name === queryNoExt || nameNoExt === queryNoExt) {
    consider(1);
  }
  if (startsWithAny(name, queryLower, queryNoExt) || startsWithAny(nameNoExt, queryLower, queryNoExt)) {
    consider(4 + Math.max(0, nameNoExt.length - queryNoExt.length) / 10);
  }
  if (startsWithAny(pathLower, queryLower, queryNoExt) || startsWithAny(pathNoExt, queryLower, queryNoExt)) {
    consider(7 + Math.max(0, pathNoExt.length - queryNoExt.length) / 20);
  }

  const segmentPrefixIdx = segments.findIndex((segment) => startsWithAny(segment, queryLower, queryNoExt));
  if (segmentPrefixIdx >= 0) {
    consider(9 + (segmentPrefixIdx * 1.5));
  }

  const nameContains = indexOfAny(name, queryLower, queryNoExt);
  if (nameContains >= 0) {
    const boundary = nameContains === 0 || SEGMENT_BOUNDARY_RE.test(name[nameContains - 1] ?? '');
    consider((boundary ? 11 : 14) + (nameContains / 10));
  }

  const pathContains = indexOfAny(pathLower, queryLower, queryNoExt);
  if (pathContains >= 0) {
    const boundary = pathContains === 0 || SEGMENT_BOUNDARY_RE.test(pathLower[pathContains - 1] ?? '');
    consider((boundary ? 16 : 20) + (pathContains / 20));
  }

  const nameSubsequence = subsequencePenalty(queryNoExt, nameNoExt);
  if (nameSubsequence !== null) {
    consider(28 + (nameSubsequence / 10));
  }

  const pathSubsequence = subsequencePenalty(queryNoExt, pathNoExt);
  if (pathSubsequence !== null) {
    consider(36 + (pathSubsequence / 10));
  }

  if (!Number.isFinite(best)) return Number.POSITIVE_INFINITY;
  return best + hiddenPenalty + (segments.length / 20);
}

function scoreTokenInText(textLower: string, tokenLower: string): number | null {
  if (!textLower || !tokenLower) return null;
  if (textLower === tokenLower) return 0;
  if (textLower.startsWith(tokenLower)) {
    return 2 + Math.max(0, textLower.length - tokenLower.length) / 50;
  }

  const contains = textLower.indexOf(tokenLower);
  if (contains >= 0) {
    const boundary = contains === 0 || SEGMENT_BOUNDARY_RE.test(textLower[contains - 1] ?? '');
    return (boundary ? 4 : 6) + (contains / 30);
  }

  const subsequence = subsequencePenalty(tokenLower, textLower);
  if (subsequence !== null) return 10 + (subsequence / 12);
  return null;
}

export interface SearchField {
  text: string;
  weight?: number;
}

/**
 * Generic ranked fuzzy query for cockpit UI lists (e.g. command palette).
 * Lower score = better.
 */
export function rankByQuery<T>(
  items: T[],
  query: string,
  toFields: (item: T) => SearchField[],
  limit = 20,
): T[] {
  if (items.length === 0) return [];

  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) return items.slice(0, Math.max(1, limit));

  const ranked = items
    .map((item, idx) => {
      const fields = toFields(item)
        .map((field) => ({
          textLower: field.text.trim().toLowerCase(),
          weight: field.weight ?? 1,
        }))
        .filter((field) => field.textLower.length > 0);
      if (fields.length === 0) return null;

      let score = 0;
      for (const token of tokens) {
        let bestTokenScore = Number.POSITIVE_INFINITY;
        for (const field of fields) {
          const tokenScore = scoreTokenInText(field.textLower, token);
          if (tokenScore === null) continue;
          const weighted = tokenScore * field.weight;
          if (weighted < bestTokenScore) bestTokenScore = weighted;
        }
        if (!Number.isFinite(bestTokenScore)) return null;
        score += bestTokenScore;
      }
      return { item, idx, score };
    })
    .filter((row): row is { item: T; idx: number; score: number } => row !== null)
    .sort((a, b) => a.score - b.score || a.idx - b.idx);

  return ranked.slice(0, Math.max(1, limit)).map((row) => row.item);
}

/**
 * Filters + ranks path suggestions for @mention.
 */
export function rankPathSuggestions(
  candidates: string[],
  query: string,
  limit = 10,
): string[] {
  if (candidates.length === 0) return [];
  const queryLower = query.trim().toLowerCase();
  const unique = Array.from(new Set(candidates.filter((v) => v && v.trim().length > 0)));

  const ranked = unique
    .map((path) => ({ path, score: scorePath(path, queryLower) }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => (
      a.score - b.score
      || a.path.split('/').length - b.path.split('/').length
      || a.path.length - b.path.length
      || a.path.localeCompare(b.path)
    ));

  return ranked.slice(0, Math.max(1, limit)).map((row) => row.path);
}
