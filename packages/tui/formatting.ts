import { getColors } from "./theme.js";
import type { HistoryLine } from "./store.js";

export interface ParsedSegment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const MAX_PARSE_TEXT_LENGTH = 20000;
const PARSE_CACHE_LIMIT = 200;
const parseCache = new Map<string, ParsedSegment[]>();

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

export function hasAnsiCodes(text: string): boolean {
  return /\x1b\[/.test(text);
}

export function visibleLength(text: string): number {
  return text.replace(ANSI_REGEX, "").length;
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

function guardItalic(text: string, match: RegExpExecArray): boolean {
  const start = match.index;
  const end = start + match[0].length;
  const before = text[start - 1];
  const after = text[end];
  if (isWordChar(before) && isWordChar(after)) {
    return false;
  }
  return true;
}

interface InlineToken {
  type: "code" | "link" | "bold" | "italic" | "strike";
  regex: RegExp;
  guard?: (text: string, match: RegExpExecArray) => boolean;
  priority: number;
}

const inlineTokens: InlineToken[] = [
  { type: "code", regex: /`([^`]+)`/g, priority: 1 },
  { type: "link", regex: /\[([^\]]+)\]\(([^)]+)\)/g, priority: 2 },
  { type: "bold", regex: /\*\*([^*]+)\*\*/g, priority: 3 },
  { type: "bold", regex: /__([^_]+)__/g, priority: 4 },
  { type: "italic", regex: /\*([^*]+)\*/g, guard: guardItalic, priority: 5 },
  { type: "italic", regex: /_([^_]+)_/g, guard: guardItalic, priority: 6 },
  { type: "strike", regex: /~~([^~]+)~~/g, priority: 7 },
];

interface PlainToken {
  type: "url" | "path" | "duration" | "tool" | "classCall" | "funcCall";
  regex: RegExp;
  priority: number;
}

const plainTokens: PlainToken[] = [
  { type: "url", regex: /https?:\/\/[^\s<>\[\]()]+/g, priority: 1 },
  { type: "path", regex: /(?<!\w)\/[\w.-]+(?:\/[\w.-]+)+/g, priority: 2 },
  { type: "duration", regex: /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|min|m|h|hr)s?\b/gi, priority: 3 },
  { type: "tool", regex: /(?<!!)\[[a-z_][a-z0-9_]*\](?!\()/gi, priority: 4 },
  { type: "classCall", regex: /\b[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*\(\)/g, priority: 5 },
  { type: "funcCall", regex: /\b[a-z_][a-zA-Z0-9_]*\(\)/g, priority: 6 },
];

interface InlineMatch {
  token: InlineToken;
  match: RegExpExecArray;
  index: number;
}

interface PlainMatch {
  token: PlainToken;
  match: RegExpExecArray;
  index: number;
}

function findNextInlineMatch(text: string, cursor: number): InlineMatch | null {
  let best: InlineMatch | null = null;
  for (const token of inlineTokens) {
    token.regex.lastIndex = cursor;
    let match: RegExpExecArray | null = null;
    while ((match = token.regex.exec(text)) !== null) {
      if (token.guard && !token.guard(text, match)) {
        continue;
      }
      const index = match.index;
      const candidate: InlineMatch = { token, match, index };
      if (!best || index < best.index || (index === best.index && token.priority < best.token.priority)) {
        best = candidate;
      }
      break;
    }
  }
  return best;
}

function findNextPlainMatch(text: string, cursor: number): PlainMatch | null {
  let best: PlainMatch | null = null;
  for (const token of plainTokens) {
    token.regex.lastIndex = cursor;
    let match: RegExpExecArray | null = null;
    while ((match = token.regex.exec(text)) !== null) {
      const index = match.index;
      const candidate: PlainMatch = { token, match, index };
      if (!best || index < best.index || (index === best.index && token.priority < best.token.priority)) {
        best = candidate;
      }
      break;
    }
  }
  return best;
}

interface InternalSegment extends ParsedSegment {
  kind?: "plain" | "styled";
}

function parseInlineMarkdown(text: string, baseColor: string | undefined): InternalSegment[] {
  const colors = getColors();
  const segments: InternalSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const next = findNextInlineMatch(text, cursor);
    if (!next) {
      segments.push({ text: text.slice(cursor), color: baseColor, kind: "plain" });
      break;
    }

    if (next.index > cursor) {
      segments.push({ text: text.slice(cursor, next.index), color: baseColor, kind: "plain" });
    }

    const matchedText = next.match[0];
    const innerText = next.match[1] ?? matchedText;

    switch (next.token.type) {
      case "code":
        segments.push({ text: innerText, color: colors.code, bold: true, kind: "styled" });
        break;
      case "link":
        segments.push({ text: innerText, color: colors.linkText, kind: "styled" });
        break;
      case "bold":
        segments.push({ text: innerText, color: baseColor, bold: true, kind: "styled" });
        break;
      case "italic":
        segments.push({ text: innerText, color: baseColor, italic: true, kind: "styled" });
        break;
      case "strike":
        segments.push({ text: innerText, color: colors.strikethrough, kind: "styled" });
        break;
      default:
        segments.push({ text: matchedText, color: baseColor, kind: "plain" });
    }

    cursor = next.index + matchedText.length;
  }

  return segments;
}

function highlightPlainText(text: string, baseColor: string | undefined): ParsedSegment[] {
  const colors = getColors();
  const segments: ParsedSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const next = findNextPlainMatch(text, cursor);
    if (!next) {
      segments.push({ text: text.slice(cursor), color: baseColor });
      break;
    }

    if (next.index > cursor) {
      segments.push({ text: text.slice(cursor, next.index), color: baseColor });
    }

    const matchedText = next.match[0];
    segments.push({
      text: matchedText,
      color: colors.muted,
      bold: next.token.type === "tool" ? true : undefined,
    });

    cursor = next.index + matchedText.length;
  }

  return segments;
}

function padSegmentsToLength(
  segments: ParsedSegment[],
  targetLength: number,
  fillStyle?: ParsedSegment,
): ParsedSegment[] {
  const currentLength = segments.reduce((sum, seg) => sum + seg.text.length, 0);
  if (currentLength < targetLength) {
    segments.push({
      text: " ".repeat(targetLength - currentLength),
      ...fillStyle,
    });
  }
  return segments;
}

function parseBlockLine(text: string, baseColor: string | undefined): { segments: ParsedSegment[]; fill?: ParsedSegment } | null {
  const colors = getColors();

  if (/^[✓✗] Edit .+$/.test(text)) {
    const segment = { text, color: colors.diffHeader, bold: true };
    return { segments: [segment], fill: segment };
  }

  if (/^\s*\d+\s+\+ .*$/.test(text)) {
    const segment = { text, color: "#4ade80" };
    return { segments: [segment], fill: segment };
  }

  if (/^\s*\d+\s+- .*$/.test(text)) {
    const segment = { text, color: "#f87171" };
    return { segments: [segment], fill: segment };
  }

  if (/^\s*\d+\s{3}.*$/.test(text)) {
    const segment = { text, color: colors.text };
    return { segments: [segment], fill: segment };
  }

  if (/^[-*_]{3,}\s*$/.test(text)) {
    const line = "─".repeat(Math.max(3, text.trim().length));
    return { segments: [{ text: line, color: colors.hr }] };
  }

  if (/^\|?[\s:]*-{3,}[\s:]*\|[\s|:\-]+\|?\s*$/.test(text)) {
    const line = text
      .replace(/\|/g, "┼")
      .replace(/-+/g, (m) => "─".repeat(m.length))
      .replace(/^┼/, "├")
      .replace(/┼$/, "┤")
      .replace(/┼\s*$/, "┤");
    return { segments: [{ text: line, color: colors.border }] };
  }

  if (/^\|.+\|\s*$/.test(text)) {
    const line = text.replace(/\|/g, "│");
    return { segments: [{ text: line, color: colors.text }] };
  }

  const headerMatch = text.match(/^(#{1,6})\s+(.+)$/);
  if (headerMatch) {
    const headerText = headerMatch[2];
    return { segments: [{ text: headerText, color: colors.header, bold: true }] };
  }

  const blockquoteMatch = text.match(/^(\s*)>\s+(.+)$/);
  if (blockquoteMatch) {
    const indent = blockquoteMatch[1];
    const rest = blockquoteMatch[2];
    const restSegments = parseInlineMarkdown(rest, colors.blockquote)
      .flatMap((seg) => (seg.kind === "plain" ? highlightPlainText(seg.text, colors.blockquote) : [seg]))
      .map((seg) => ({ ...seg, italic: true }));
    return {
      segments: [
        { text: indent, color: baseColor },
        { text: "│ ", color: colors.blockquote, italic: true },
        ...restSegments,
      ],
    };
  }

  const taskMatch = text.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/);
  if (taskMatch) {
    const indent = taskMatch[1];
    const checked = taskMatch[2].toLowerCase() === "x";
    const rest = taskMatch[3];
    const restSegments = parseInlineMarkdown(rest, baseColor)
      .flatMap((seg) => (seg.kind === "plain" ? highlightPlainText(seg.text, baseColor) : [seg]));
    return {
      segments: [
        { text: indent, color: baseColor },
        { text: checked ? "☑ " : "☐ ", color: colors.text },
        ...restSegments,
      ],
    };
  }

  const unorderedMatch = text.match(/^(\s*)[-*+]\s+(.+)$/);
  if (unorderedMatch) {
    const indent = unorderedMatch[1];
    const rest = unorderedMatch[2];
    const restSegments = parseInlineMarkdown(rest, baseColor)
      .flatMap((seg) => (seg.kind === "plain" ? highlightPlainText(seg.text, baseColor) : [seg]));
    return {
      segments: [
        { text: indent, color: baseColor },
        { text: "• ", color: colors.text },
        ...restSegments,
      ],
    };
  }

  const orderedMatch = text.match(/^(\s*)(\d+\.)\s+(.+)$/);
  if (orderedMatch) {
    const indent = orderedMatch[1];
    const marker = orderedMatch[2];
    const rest = orderedMatch[3];
    const restSegments = parseInlineMarkdown(rest, baseColor)
      .flatMap((seg) => (seg.kind === "plain" ? highlightPlainText(seg.text, baseColor) : [seg]));
    return {
      segments: [
        { text: indent, color: baseColor },
        { text: `${marker} `, color: colors.text },
        ...restSegments,
      ],
    };
  }

  return null;
}

export function parseTextSegments(text: string, baseColor?: string): ParsedSegment[] {
  if (text.length > MAX_PARSE_TEXT_LENGTH) {
    return [{ text, color: baseColor }];
  }

  const cacheKey = `${baseColor ?? ""}::${text}`;
  const cached = parseCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const targetLength = text.length;
  const trimmedLine = text.replace(/\s+$/, "");
  const trailingSpaces = targetLength - trimmedLine.length;

  const block = parseBlockLine(trimmedLine, baseColor);
  if (block) {
    const segments = padSegmentsToLength(
      block.segments,
      trimmedLine.length + trailingSpaces,
      block.fill ?? { color: baseColor },
    );
    const result = segments;
    if (parseCache.size >= PARSE_CACHE_LIMIT) {
      const oldestKey = parseCache.keys().next().value;
      if (oldestKey) parseCache.delete(oldestKey);
    }
    parseCache.set(cacheKey, result);
    return result;
  }

  const inlineSegments = parseInlineMarkdown(trimmedLine, baseColor);
  const merged = inlineSegments.flatMap((seg) =>
    seg.kind === "plain" ? highlightPlainText(seg.text, baseColor) : [{ ...seg }],
  );

  const padded = padSegmentsToLength(merged, trimmedLine.length + trailingSpaces, { color: baseColor });

  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    const oldestKey = parseCache.keys().next().value;
    if (oldestKey) {
      parseCache.delete(oldestKey);
    }
  }
  parseCache.set(cacheKey, padded);
  return padded;
}

/**
 * Apply visual spacing rules to history lines:
 * - Collapse multiple blank lines
 * - Add spacing after reasoning blocks
 */
export function applyVisualSpacing(lines: HistoryLine[]): HistoryLine[] {
  const out: HistoryLine[] = [];
  let prevWasBlank = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const baseId = line.id ?? `line-${i}`;
    const text = line.text ?? "";
    const trimmed = text.trim();
    const isBlank = trimmed.length === 0;

    if (isBlank && prevWasBlank) {
      continue;
    }

    out.push(line);
    prevWasBlank = isBlank;

    const next = lines[i + 1];
    const nextIsBlank = (next?.text ?? "").trim().length === 0;

    if (line.role === "reasoning" && next && next.role !== "reasoning" && !isBlank && !nextIsBlank) {
      out.push({ id: `${baseId}-sp-r`, text: "", role: "reasoning" });
      prevWasBlank = true;
    }
  }

  return out;
}
