import type { CockpitMarkdownTreeNode } from './api';

// ============ Frontmatter Utilities ============

export type DocumentType = 'note' | 'issue' | 'workflow' | 'executable';

export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};

  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Parse arrays: [a, b, c]
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    }
    // Parse booleans and numbers
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    // Strip quotes
    else if (typeof value === 'string' && value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

export function serializeFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const entries = Object.entries(frontmatter).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return body;

  const lines = entries.map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: [${value.join(', ')}]`;
    return `${key}: ${String(value)}`;
  });

  return `---\n${lines.join('\n')}\n---\n${body}`;
}

export function getDocumentType(content: string): DocumentType {
  const { frontmatter } = parseFrontmatter(content);
  const type = frontmatter.type;
  if (frontmatter.sessionKey) return 'executable';
  if (type === 'workflow') return 'workflow';
  if (type === 'issue') return 'issue';
  return 'note';
}

export function getDocumentSessionKey(content: string): string | null {
  const { frontmatter } = parseFrontmatter(content);
  return typeof frontmatter.sessionKey === 'string' ? frontmatter.sessionKey : null;
}

export function promoteToIssue(content: string): string {
  const { frontmatter: existing, body } = parseFrontmatter(content);
  const lines = body.split('\n').filter((l) => l.trim());

  // Extract title from first heading or first non-empty line
  let title = '';
  let descriptionBody = body;
  const headingMatch = lines[0]?.match(/^#+\s+(.+)/);
  if (headingMatch) {
    title = headingMatch[1].trim();
    descriptionBody = lines.slice(1).join('\n').trim();
  } else if (lines[0]) {
    title = lines[0].trim();
    descriptionBody = lines.slice(1).join('\n').trim();
  }

  const frontmatter: Record<string, unknown> = {
    ...existing,
    type: 'issue',
    title: title || 'Untitled Issue',
    description: descriptionBody.slice(0, 200) || '',
    acceptance_criteria: [],
  };

  const structuredBody = [
    `# ${frontmatter.title}`,
    '',
    descriptionBody || '*Add description...*',
    '',
    '## Acceptance Criteria',
    '',
    '- [ ] *Define acceptance criteria...*',
  ].join('\n');

  return serializeFrontmatter(frontmatter, structuredBody);
}

// ============ Path Utilities ============

export function normalizeDocPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((part) => part === '.' || part === '..')) return null;
  const joined = parts.join('/');
  return /\.(md|markdown|mdx)$/i.test(joined) ? joined : `${joined}.md`;
}

export function normalizeWorkspacePathForClient(rawPath: string, allowEmpty = false): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return allowEmpty ? '' : null;
  const normalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return allowEmpty ? '' : null;
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.join('/');
}

export function flattenMarkdownFiles(tree: CockpitMarkdownTreeNode[]): string[] {
  const files: string[] = [];
  const visit = (node: CockpitMarkdownTreeNode) => {
    if (node.type === 'file') {
      files.push(node.path);
      return;
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  for (const node of tree) {
    visit(node);
  }
  return files;
}

export function gatherMarkdownFolders(tree: CockpitMarkdownTreeNode[]): string[] {
  const folders = new Set<string>();
  const visit = (node: CockpitMarkdownTreeNode) => {
    if (node.type === 'folder') {
      folders.add(node.path);
      for (const child of node.children ?? []) {
        visit(child);
      }
    }
  };
  for (const node of tree) {
    visit(node);
  }
  return Array.from(folders);
}
