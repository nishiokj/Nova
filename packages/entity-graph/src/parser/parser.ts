/**
 * Tree-sitter Parser Factory
 *
 * Creates and caches tree-sitter parsers per language.
 * Maps file extensions to the appropriate grammar.
 */

import Parser from 'tree-sitter'
import TypeScript from 'tree-sitter-typescript'
import JavaScript from 'tree-sitter-javascript'

const { typescript: TSLanguage, tsx: TSXLanguage } = TypeScript

export type SupportedLanguage = 'typescript' | 'tsx' | 'javascript' | 'jsx'

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mts': 'typescript',
  '.mjs': 'javascript',
  '.cts': 'typescript',
  '.cjs': 'javascript',
}

const LANGUAGE_MAP: Record<SupportedLanguage, Parser.Language> = {
  typescript: TSLanguage as unknown as Parser.Language,
  tsx: TSXLanguage as unknown as Parser.Language,
  javascript: JavaScript as unknown as Parser.Language,
  jsx: JavaScript as unknown as Parser.Language,
}

/** Cache of parser instances per language */
const parserCache = new Map<SupportedLanguage, Parser>()

/**
 * Determine the language for a file path based on extension.
 * Returns null for unsupported files.
 */
export function languageForFile(filepath: string): SupportedLanguage | null {
  const dot = filepath.lastIndexOf('.')
  if (dot === -1) return null
  const ext = filepath.slice(dot)
  return EXTENSION_MAP[ext] ?? null
}

/**
 * Get or create a parser for the given language.
 * Parsers are cached and reused — tree-sitter parsers are stateful but
 * parse() resets state, so reuse is safe.
 */
export function createParser(lang: SupportedLanguage): Parser {
  const cached = parserCache.get(lang)
  if (cached) return cached

  const parser = new Parser()
  parser.setLanguage(LANGUAGE_MAP[lang])
  parserCache.set(lang, parser)
  return parser
}

/**
 * Parse source text for the given language.
 * Returns the syntax tree or null if the language is unsupported.
 */
export function parseSource(source: string, lang: SupportedLanguage): Parser.Tree {
  const parser = createParser(lang)
  return parser.parse(source)
}
