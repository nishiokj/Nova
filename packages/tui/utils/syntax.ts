/**
 * Syntax Highlighting using Tree-sitter
 *
 * Leverages entity-graph's Tree-sitter parsers for code syntax highlighting
 * in the TUI. Provides ANSI-colored output for code blocks.
 *
 * Uses the TUI theme system for consistent, themeable syntax highlighting.
 */

import Parser from 'tree-sitter'
import { languageForFile, createParser, type SupportedLanguage } from 'entity-graph'
import { Chalk } from 'chalk'
import { getColors, type ThemeColors, getCurrentThemeName } from '../theme.js'

// Create a chalk instance with forced color support (consistent with markdown.ts)
const chalk = new Chalk({ level: 3 })

/**
 * Create color functions from theme hex colors.
 */
function createThemeColorFunctions(colors: ThemeColors) {
  return {
    keyword: chalk.hex(colors.accent),
    string: chalk.hex(colors.code),
    number: chalk.hex(colors.number),
    comment: chalk.hex(colors.muted).italic,
    function: chalk.hex(colors.func),
    identifier: chalk.hex(colors.text),
    type: chalk.hex(colors.url),
    operator: chalk.hex(colors.accent),
    property: chalk.hex(colors.path),
    decorator: chalk.hex(colors.header),
    literal: chalk.hex(colors.number),
    variable: chalk.hex(colors.text),
    parameter: chalk.hex(colors.text),
    text: chalk.hex(colors.text),
  }
}

// Cache for color functions based on current theme
let cachedColorFunctions: ReturnType<typeof createThemeColorFunctions> | null = null
let cachedThemeName: string | null = null

/**
 * Get theme-based color functions, caching the result.
 */
function getThemeColorFunctions() {
  const currentTheme = getCurrentThemeName()
  
  if (cachedColorFunctions && cachedThemeName === currentTheme) {
    return cachedColorFunctions
  }

  const colors = getColors()
  cachedColorFunctions = createThemeColorFunctions(colors)
  cachedThemeName = currentTheme
  
  return cachedColorFunctions
}

/**
 * Get color mapping for Tree-sitter node types based on current theme.
 * Maps syntax node types to theme-based ANSI colors.
 */
function getNodeColorMapping(): Record<string, (text: string) => string> {
  const colors = getThemeColorFunctions()

  return {
    // Keywords - use accent color
    'const': colors.keyword,
    'let': colors.keyword,
    'var': colors.keyword,
    'function': colors.keyword,
    'return': colors.keyword,
    'if': colors.keyword,
    'else': colors.keyword,
    'for': colors.keyword,
    'while': colors.keyword,
    'do': colors.keyword,
    'switch': colors.keyword,
    'case': colors.keyword,
    'break': colors.keyword,
    'continue': colors.keyword,
    'try': colors.keyword,
    'catch': colors.keyword,
    'finally': colors.keyword,
    'throw': colors.keyword,
    'new': colors.keyword,
    'class': colors.keyword,
    'extends': colors.keyword,
    'implements': colors.keyword,
    'interface': colors.keyword,
    'type': colors.keyword,
    'enum': colors.keyword,
    'import': colors.keyword,
    'export': colors.keyword,
    'from': colors.keyword,
    'default': colors.keyword,
    'async': colors.keyword,
    'await': colors.keyword,
    'typeof': colors.keyword,
    'instanceof': colors.keyword,
    'in': colors.keyword,
    'of': colors.keyword,

    // Literals - use number color
    'null': colors.literal,
    'undefined': colors.literal,
    'true': colors.literal,
    'false': colors.literal,

    // Strings - use code color
    'string': colors.string,
    'template_string': colors.string,
    'character': colors.string,

    // Comments - use muted color with italic
    'comment': colors.comment,
    'line_comment': colors.comment,
    'block_comment': colors.comment,
    'jsdoc': colors.comment,

    // Numbers - use number color
    'number': colors.number,
    'integer': colors.number,
    'float': colors.number,

    // Identifiers (leaf nodes)
    'identifier': colors.identifier,
    'property_identifier': colors.property,
    'shorthand_property_identifier': colors.property,
    'shorthand_property_identifier_pattern': colors.property,
    'type_identifier': colors.type,

    // Keywords as identifiers
    'this': colors.variable,
    'super': colors.variable,

    // Built-in types (leaf nodes)
    'predefined_type': colors.type,

    // JSX leaf nodes
    'jsx_text': colors.text,

    // Decorator @ symbol
    '@': colors.decorator,

    // Modifiers (leaf keyword tokens)
    'public': colors.keyword,
    'private': colors.keyword,
    'protected': colors.keyword,
    'readonly': colors.keyword,
    'static': colors.keyword,
    'abstract': colors.keyword,
    'declare': colors.keyword,
    'override': colors.keyword,

    // Type operators (leaf tokens)
    '|': colors.operator,
    '&': colors.operator,
    '?': colors.operator,

    // Additional literals
    'regex': colors.string,
    'regex_pattern': colors.string,

    // JSX tag names (leaf nodes)
    'jsx_identifier': colors.function,

    // Operators (leaf punctuation tokens)
    '=>': colors.operator,
    '...': colors.operator,
    '?.': colors.operator,
    '??': colors.operator,
    '++': colors.operator,
    '--': colors.operator,
    '&&': colors.operator,
    '||': colors.operator,

    // Punctuation that provides structure (intentionally light)
    '{': colors.text,
    '}': colors.text,
    '(': colors.text,
    ')': colors.text,
    '[': colors.text,
    ']': colors.text,
    ';': colors.text,
    ',': colors.text,
    '.': colors.text,
    ':': colors.text,
    '=': colors.operator,
    '<': colors.operator,
    '>': colors.operator,
  }
}

/**
 * Language alias mapping for common code block identifiers.
 */
const LANGUAGE_ALIASES: Record<string, SupportedLanguage> = {
  'ts': 'typescript',
  'typescript': 'typescript',
  '.ts': 'typescript',
  'tsx': 'tsx',
  '.tsx': 'tsx',
  'js': 'javascript',
  'javascript': 'javascript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  'jsx': 'jsx',
  '.jsx': 'jsx',
}

/**
 * Detect supported language from a code block language identifier.
 */
function detectLanguage(lang: string | undefined): SupportedLanguage | null {
  if (!lang) return null

  const normalized = lang.toLowerCase().trim()

  // Check direct aliases
  if (LANGUAGE_ALIASES[normalized]) {
    return LANGUAGE_ALIASES[normalized]
  }

  // Try as extension
  const ext = normalized.startsWith('.') ? normalized : `.${normalized}`
  return languageForFile(`dummy${ext}`)
}

/**
 * Check if a language is supported for syntax highlighting.
 */
export function isLanguageSupported(lang: string | undefined): boolean {
  return detectLanguage(lang) !== null
}

/**
 * Get the color function for a node type using current theme.
 */
function getColorForNode(nodeType: string): ((text: string) => string) | null {
  const mapping = getNodeColorMapping()
  return mapping[nodeType] ?? null
}

/**
 * Highlight code using Tree-sitter syntax highlighting.
 *
 * @param code - The source code to highlight
 * @param lang - The language identifier (e.g., 'typescript', 'javascript')
 * @returns ANSI-colored string for terminal display, or null if input is null
 */
export function highlightCode(code: string | null, lang: string | undefined): string {
  // Handle null/undefined input - return empty string
  if (code == null) return ''

  // Skip highlighting for empty code
  if (code.trim() === '') {
    return code
  }

  // Detect language
  const supportedLang = detectLanguage(lang)

  // For unsupported languages, still apply code styling (muted text on black bg)
  // This makes code blocks visually distinct from regular text
  if (!supportedLang) {
    const colors = getColors()
    return chalk.bgBlack.hex(colors.muted)(code)
  }

  try {
    // Parse the code
    const parser = createParser(supportedLang)
    const tree = parser.parse(code)

    // Apply highlighting without background (syntax only)
    const highlighted = highlightTree(tree, code)

    // Return highlighted code without background
    return highlighted
  } catch (error) {
    // If parsing fails, return plain code without background
    return code
  }
}

/**
 * Walk a Tree-sitter syntax tree and apply colors.
 *
 * Collects all highlightable nodes and applies colors to build the output.
 */
function highlightTree(tree: Parser.Tree, source: string): string {
  const root = tree.rootNode

  // Check for parse errors (still try to highlight what we can)
  // Note: hasError is a property in entity-graph's tree-sitter binding, not a method
  const hasError = root.hasError

  // Collect all highlightable nodes with their ranges
  const highlights: Array<{ start: number; end: number; color: (text: string) => string }> = []

  // Walk the tree and collect nodes that have color mappings
  const walk = (node: Parser.SyntaxNode) => {
    const color = getColorForNode(node.type)
    if (color && node.text.length > 0) {
      highlights.push({
        start: node.startIndex,
        end: node.endIndex,
        color,
      })
    }

    // Recursively walk ALL children (named and unnamed)
    // Keywords like 'function', 'return' are unnamed children
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i))
    }
  }

  walk(root)

  // If no highlights found, return original code
  if (highlights.length === 0) {
    return source
  }

  // Sort highlights by start position
  highlights.sort((a, b) => a.start - b.start)

  // Build the output string with ANSI codes
  return applyHighlights(source, highlights)
}

/**
 * Apply highlights to source text, handling overlapping ranges.
 *
 * Uses a character-by-character approach to ensure correct nesting
 * of ANSI codes.
 */
function applyHighlights(
  source: string,
  highlights: Array<{ start: number; end: number; color: (text: string) => string }>
): string {
  // Track which character positions are colored and by which highlight
  const charColors: Array<{ color: (text: string) => string } | null> = new Array(source.length).fill(null)

  // Assign colors to characters (last highlight wins for overlaps)
  for (const h of highlights) {
    for (let i = h.start; i < h.end && i < source.length; i++) {
      charColors[i] = h.color
    }
  }

  // Build output with ANSI codes
  let result = ''
  let i = 0

  while (i < source.length) {
    const color = charColors[i]

    if (!color) {
      // No color, just add character
      result += source[i]
      i++
      continue
    }

    // Find run of same color
    const start = i
    while (i < source.length && charColors[i] === color) {
      i++
    }

    // Add colored text
    result += color(source.slice(start, i))
  }

  return result
}
