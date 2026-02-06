export const PACKET_REF_REGEX = /@([a-zA-Z]+)\(([^)]+)\)/g;

export interface PacketFrontmatter {
  type?: string;
  sessionKey?: string;
  workItemId?: string;
  requestedDecision?: string;
  priority?: string;
  links: Array<{ label: string; target: string }>;
  refs: Array<{ type: string; target: string }>;
}

export interface ParsedPacketMarkdown {
  frontmatter: PacketFrontmatter | null;
  bodyMarkdown: string;
}

export function unquoteYamlValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parsePacketMarkdown(markdown: string): ParsedPacketMarkdown {
  if (!markdown.startsWith('---')) {
    return { frontmatter: null, bodyMarkdown: markdown };
  }
  const lines = markdown.split('\n');
  if (lines[0].trim() !== '---') {
    return { frontmatter: null, bodyMarkdown: markdown };
  }
  let endIndex = -1;
  for (let idx = 1; idx < lines.length; idx += 1) {
    if (lines[idx].trim() === '---') {
      endIndex = idx;
      break;
    }
  }
  if (endIndex < 0) {
    return { frontmatter: null, bodyMarkdown: markdown };
  }

  const scalar: Record<string, string> = {};
  const links: Array<{ label: string; target: string }> = [];
  const refs: Array<{ type: string; target: string }> = [];
  let section: string | null = null;

  for (const rawLine of lines.slice(1, endIndex)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const isRoot = !rawLine.startsWith(' ') && !rawLine.startsWith('\t');
    if (isRoot) {
      const rootMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!rootMatch) {
        section = null;
        continue;
      }
      const key = rootMatch[1];
      const value = rootMatch[2];
      if (value) {
        scalar[key] = unquoteYamlValue(value);
        section = null;
      } else {
        section = key.toLowerCase();
      }
      continue;
    }

    const nested = trimmed;
    if (section === 'links') {
      const linkMatch = nested.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
      if (linkMatch) {
        links.push({
          label: linkMatch[1],
          target: unquoteYamlValue(linkMatch[2]),
        });
      }
      continue;
    }

    if (section === 'refs') {
      const refMatch = nested.match(/^-+\s*([A-Za-z0-9_-]+):\s*(.+)$/);
      if (refMatch) {
        refs.push({
          type: refMatch[1],
          target: unquoteYamlValue(refMatch[2]),
        });
      }
    }
  }

  const frontmatter: PacketFrontmatter | null = (
    Object.keys(scalar).length > 0 || links.length > 0 || refs.length > 0
  )
    ? {
        type: scalar.type,
        sessionKey: scalar.sessionKey,
        workItemId: scalar.workItemId,
        requestedDecision: scalar.requestedDecision,
        priority: scalar.priority,
        links,
        refs,
      }
    : null;

  let bodyMarkdown = lines.slice(endIndex + 1).join('\n');
  while (bodyMarkdown.startsWith('\n')) {
    bodyMarkdown = bodyMarkdown.slice(1);
  }

  return { frontmatter, bodyMarkdown };
}

export interface InlineRefSegment {
  type: 'text' | 'ref';
  value: string;
  refType?: string;
  target?: string;
  resolved?: boolean;
}

export function parseInlineRefs(
  text: string,
  isRefResolved: (refType: string, target: string) => boolean
): InlineRefSegment[] {
  const segments: InlineRefSegment[] = [];
  const regex = new RegExp(PACKET_REF_REGEX.source, 'g');
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > index) {
      segments.push({ type: 'text', value: text.slice(index, match.index) });
    }
    const refType = match[1];
    const target = match[2];
    segments.push({
      type: 'ref',
      value: `@${refType}(${target})`,
      refType,
      target,
      resolved: isRefResolved(refType, target),
    });
    index = match.index + match[0].length;
  }

  if (index < text.length) {
    segments.push({ type: 'text', value: text.slice(index) });
  }

  return segments;
}

export function parseFileRefTarget(target: string): { path: string; line?: number } {
  const [pathPart, fragment] = target.split('#');
  if (!fragment) return { path: pathPart };
  const lineMatch = fragment.match(/L(\d+)/i);
  if (!lineMatch) return { path: pathPart };
  return {
    path: pathPart,
    line: Number(lineMatch[1]),
  };
}
