/**
 * Tree-sitter Parser Factory (WASM)
 *
 * Uses web-tree-sitter (WASM) instead of native NAPI bindings for
 * cross-platform compatibility (works on all OS/arch combos with bun/node).
 *
 * Requires one-time async initialization via initParser() before use.
 */

import { readFile } from 'node:fs/promises'
import { Parser, Language } from 'web-tree-sitter'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

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

/** Resolve the .wasm path for a grammar package */
function resolveWasmPath(packageName: string, wasmFile: string): string {
  const pkgJson = require.resolve(`${packageName}/package.json`)
  const pkgDir = pkgJson.replace(/\/package\.json$/, '')
  return `${pkgDir}/${wasmFile}`
}

/** Read a .wasm file and load it as a Language via buffer (avoids web-tree-sitter's broken ESM require shim) */
async function loadLanguageFromWasm(packageName: string, wasmFile: string): Promise<Language> {
  const wasmPath = resolveWasmPath(packageName, wasmFile)
  const buf = await readFile(wasmPath)
  return Language.load(buf)
}

let initialized = false
const languageCache = new Map<SupportedLanguage, Language>()
const parserCache = new Map<SupportedLanguage, Parser>()

/**
 * Initialize web-tree-sitter and load all grammar .wasm files.
 * Must be called once before createParser/parseSource.
 * Safe to call multiple times (no-ops after first init).
 */
export async function initParser(): Promise<void> {
  if (initialized) return

  await Parser.init()

  const [tsLang, tsxLang, jsLang] = await Promise.all([
    loadLanguageFromWasm('tree-sitter-typescript', 'tree-sitter-typescript.wasm'),
    loadLanguageFromWasm('tree-sitter-typescript', 'tree-sitter-tsx.wasm'),
    loadLanguageFromWasm('tree-sitter-javascript', 'tree-sitter-javascript.wasm'),
  ])

  languageCache.set('typescript', tsLang)
  languageCache.set('tsx', tsxLang)
  languageCache.set('javascript', jsLang)
  languageCache.set('jsx', jsLang)

  initialized = true
}

/**
 * Check if the parser has been initialized.
 */
export function isParserInitialized(): boolean {
  return initialized
}

/**
 * Get the Language object for a supported language.
 * Throws if initParser() hasn't been called.
 */
export function getLanguage(lang: SupportedLanguage): Language {
  const language = languageCache.get(lang)
  if (!language) {
    throw new Error(`Parser not initialized. Call initParser() first.`)
  }
  return language
}

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
 * Throws if initParser() hasn't been called.
 */
export function createParser(lang: SupportedLanguage): Parser {
  const cached = parserCache.get(lang)
  if (cached) return cached

  const language = getLanguage(lang)
  const parser = new Parser()
  parser.setLanguage(language)
  parserCache.set(lang, parser)
  return parser
}

/**
 * Parse source text for the given language.
 * Returns the syntax tree.
 * Throws if initParser() hasn't been called.
 */
export function parseSource(source: string, lang: SupportedLanguage): ReturnType<Parser['parse']> {
  const parser = createParser(lang)
  return parser.parse(source)
}
