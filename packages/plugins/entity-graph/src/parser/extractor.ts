/**
 * Entity Extractor
 *
 * Walks a tree-sitter syntax tree and produces Entity[] and Edge[] arrays.
 * Uses tree-sitter's Query API for pattern matching, with manual tree-walking
 * for exported/async flags and ownership relationships.
 */

import { statSync } from 'fs'
import path from 'path'
import type { Language, Node, Tree } from 'web-tree-sitter'
import { Query } from 'web-tree-sitter'
import type { Entity, Edge, ParseResult, EntityKind, EnvRead, ConstructorDep, FunctionDep } from '../types.js'
import type { SupportedLanguage } from './parser.js'
import {
  CLASS_QUERY,
  FUNCTION_DECLARATION_QUERY,
  ARROW_FUNCTION_QUERY,
  METHOD_QUERY,
  INTERFACE_QUERY,
  TYPE_ALIAS_QUERY,
  ENUM_QUERY,
  NAMED_IMPORT_QUERY,
  DEFAULT_IMPORT_QUERY,
  NAMESPACE_IMPORT_QUERY,
  CALL_EXPRESSION_QUERY,
  EXTENDS_CLAUSE_QUERY,
  IMPLEMENTS_CLAUSE_QUERY,
  ENV_MEMBER_QUERY,
  ENV_SUBSCRIPT_QUERY,
  ENV_DESTRUCTURE_QUERY,
} from './queries.js'

// --- Helpers ---

/**
 * Build a composite entity ID: `kind:filepath:name`
 */
export function entityId(kind: EntityKind, filepath: string, name: string): string {
  return `${kind}:${filepath}:${name}`
}

/**
 * Check if a node is inside an export_statement (export { ... }, export default, export const, etc.)
 */
function isExported(node: Node): boolean {
  let parent = node.parent
  while (parent) {
    if (parent.type === 'export_statement') return true
    // For class/function declarations that are direct children of export
    if (parent.type === 'program') break
    parent = parent.parent
  }
  return false
}

/**
 * Check if a function/method node has the `async` keyword.
 */
function isAsync(node: Node): boolean {
  // For function_declaration, arrow_function, method_definition:
  // the "async" keyword appears as a child token
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child && child.type === 'async') return true
  }
  // Also check text prefix for arrow functions assigned via variable declarator
  if (node.type === 'arrow_function') {
    const parent = node.parent
    if (parent?.type === 'variable_declarator') {
      // Check the lexical_declaration grandparent for "async" before the arrow
      const text = node.text
      return text.startsWith('async')
    }
  }
  return false
}

/**
 * Strip quotes from a string literal node's text.
 */
function stripQuotes(text: string): string {
  if ((text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Get raw text for an entity, truncated to avoid storing huge class bodies.
 */
function getRawText(node: Node, maxLen = 2000): string | null {
  const text = node.text
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '...'
}

// --- Import Resolution ---

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

/**
 * Resolve a module specifier to a file path relative to sourceRoot.
 * Returns null for bare specifiers (external packages) or unresolvable paths.
 */
function resolveImportSource(
  specifier: string,
  currentFilepath: string,
  sourceRoot: string
): string | null {
  // Bare specifiers are external packages
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null
  }

  const currentDir = path.dirname(path.resolve(sourceRoot, currentFilepath))
  const base = path.resolve(currentDir, specifier)

  // Try exact file, then with extensions, then as directory with index file
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map(ext => base + ext),
    ...RESOLVE_EXTENSIONS.map(ext => path.join(base, `index${ext}`)),
  ]

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return path.relative(sourceRoot, candidate)
      }
    } catch {
      continue
    }
  }

  return null
}

/**
 * Resolve a callee name to a known entity ID in the current file.
 * Tries function, then method (any class). Returns null if unresolvable.
 */
function resolveCallTarget(
  calleeName: string,
  filepath: string,
  knownEntities: Set<string>
): string | null {
  // Try as a top-level function
  const funcId = entityId('function', filepath, calleeName)
  if (knownEntities.has(funcId)) return funcId

  // Try as a method on any class
  const methodSuffix = `.${calleeName}`
  for (const id of knownEntities) {
    if (id.startsWith('method:') && id.endsWith(methodSuffix)) {
      return id
    }
  }

  return null
}

// --- Query Runner ---

interface CaptureResult {
  name: string
  node: Node
}

/**
 * Run a tree-sitter query and return captures.
 */
function runQuery(language: Language, queryStr: string, rootNode: Node): CaptureResult[] {
  try {
    const q = new Query(language, queryStr)
    return q.captures(rootNode)
  } catch {
    // Query construction can fail for some grammar/query combinations
    return []
  }
}

// --- Main Extractor ---

/**
 * Extract entities and edges from a parsed syntax tree.
 *
 * @param tree - tree-sitter parse result
 * @param filepath - source file path (relative to source root)
 * @param language - which language grammar was used
 * @returns ParseResult with entities and edges
 */
export function extract(
  tree: Tree,
  filepath: string,
  _language: SupportedLanguage,
  tsLanguage: Language,
  sourceRoot: string
): ParseResult {
  const entities: Entity[] = []
  const edges: Edge[] = []
  const envReads: EnvRead[] = []
  const constructorDeps: ConstructorDep[] = []
  const functionDeps: FunctionDep[] = []
  const entitySet = new Set<string>() // dedup by ID

  // Import symbol map for cross-file call resolution: symbolName → resolvedFilePath
  const importSymbolMap = new Map<string, string>()

  const rootNode = tree.rootNode

  // --- File entity (always created) ---
  const fileId = entityId('file', filepath, filepath)
  entities.push({
    id: fileId,
    kind: 'file',
    name: filepath,
    filepath,
    startLine: 1,
    endLine: rootNode.endPosition.row + 1,
    exported: false,
    async: false,
    rawText: null,
    paramsText: null,
    returnText: null,
  })
  entitySet.add(fileId)

  // Helper to add entity + owns edge
  function addEntity(
    kind: EntityKind,
    name: string,
    node: Node,
    ownerId?: string,
    paramsText?: string | null,
    returnText?: string | null,
  ): string {
    const id = entityId(kind, filepath, name)
    if (entitySet.has(id)) return id
    entitySet.add(id)

    entities.push({
      id,
      kind,
      name,
      filepath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: isExported(node),
      async: isAsync(node),
      rawText: getRawText(node),
      paramsText: paramsText ?? null,
      returnText: returnText ?? null,
    })

    // Ownership edge (file owns class, class owns method, etc.)
    const owner = ownerId ?? fileId
    edges.push({ type: 'owns', sourceId: owner, targetId: id })

    return id
  }

  // --- Extract classes ---
  const classCaptures = runQuery(tsLanguage, CLASS_QUERY, rootNode)
  const classIds = new Map<string, string>() // className -> entityId

  for (const cap of classCaptures) {
    if (cap.name === 'class.name') {
      const className = cap.node.text
      const classNode = cap.node.parent! // class_declaration
      const id = addEntity('class', className, classNode)
      classIds.set(className, id)
    }
  }

  // --- Extract methods (need class context) ---
  const methodCaptures = runQuery(tsLanguage, METHOD_QUERY, rootNode)
  let currentMethodClass = ''

  for (const cap of methodCaptures) {
    if (cap.name === 'method.class_name') {
      currentMethodClass = cap.node.text
    } else if (cap.name === 'method.name') {
      const methodName = cap.node.text
      const methodNode = cap.node.parent! // method_definition
      const ownerId = classIds.get(currentMethodClass)
      const qualName = `${currentMethodClass}.${methodName}`
      const { paramsText, returnText } = extractSignature(methodNode)
      const id = addEntity('method', qualName, methodNode, ownerId, paramsText, returnText)

      // Extract method params as function deps
      const params = extractParams(methodNode)
      for (const p of params) {
        functionDeps.push({ functionId: id, ...p })
      }

      // Constructor params → constructor_deps
      if (methodName === 'constructor' && ownerId) {
        for (const p of params) {
          constructorDeps.push({ classId: ownerId, ...p })
        }
      }
    }
  }

  // --- Extract functions ---
  const funcCaptures = runQuery(tsLanguage, FUNCTION_DECLARATION_QUERY, rootNode)
  for (const cap of funcCaptures) {
    if (cap.name === 'func.name') {
      const funcNode = cap.node.parent! // function_declaration
      const { paramsText, returnText } = extractSignature(funcNode)
      const id = addEntity('function', cap.node.text, funcNode, undefined, paramsText, returnText)
      const params = extractParams(funcNode)
      for (const p of params) {
        functionDeps.push({ functionId: id, ...p })
      }
    }
  }

  // --- Extract arrow functions ---
  const arrowCaptures = runQuery(tsLanguage, ARROW_FUNCTION_QUERY, rootNode)
  for (const cap of arrowCaptures) {
    if (cap.name === 'arrow.name') {
      const varDecl = cap.node.parent! // variable_declarator
      const arrowNode = varDecl.childForFieldName('value')
      const outerNode = varDecl.parent ?? varDecl
      const { paramsText, returnText } = arrowNode
        ? extractSignature(arrowNode)
        : { paramsText: null, returnText: null }
      const id = addEntity('function', cap.node.text, outerNode, undefined, paramsText, returnText)
      if (arrowNode) {
        const params = extractParams(arrowNode)
        for (const p of params) {
          functionDeps.push({ functionId: id, ...p })
        }
      }
    }
  }

  // --- Extract interfaces ---
  const ifaceCaptures = runQuery(tsLanguage, INTERFACE_QUERY, rootNode)
  for (const cap of ifaceCaptures) {
    if (cap.name === 'iface.name') {
      addEntity('interface', cap.node.text, cap.node.parent!)
    }
  }

  // --- Extract type aliases ---
  const typeCaptures = runQuery(tsLanguage, TYPE_ALIAS_QUERY, rootNode)
  for (const cap of typeCaptures) {
    if (cap.name === 'type.name') {
      addEntity('type', cap.node.text, cap.node.parent!)
    }
  }

  // --- Extract enums ---
  const enumCaptures = runQuery(tsLanguage, ENUM_QUERY, rootNode)
  for (const cap of enumCaptures) {
    if (cap.name === 'enum.name') {
      addEntity('enum', cap.node.text, cap.node.parent!)
    }
  }

  // --- Extract import edges + build symbol map for cross-file call resolution ---
  const namedImportCaptures = runQuery(tsLanguage, NAMED_IMPORT_QUERY, rootNode)
  let currentImportSymbol = ''

  for (const cap of namedImportCaptures) {
    if (cap.name === 'import.name') {
      currentImportSymbol = cap.node.text
    } else if (cap.name === 'import.source') {
      const source = stripQuotes(cap.node.text)
      const resolvedPath = resolveImportSource(source, filepath, sourceRoot)
      if (resolvedPath) {
        const importedFileId = entityId('file', resolvedPath, resolvedPath)
        edges.push({
          type: 'imports',
          sourceId: fileId,
          targetId: importedFileId,
          meta: { symbol: currentImportSymbol },
        })
        // Map imported symbol for cross-file call resolution
        importSymbolMap.set(currentImportSymbol, resolvedPath)
      }
    }
  }

  const defaultImportCaptures = runQuery(tsLanguage, DEFAULT_IMPORT_QUERY, rootNode)
  let currentDefaultName = ''
  for (const cap of defaultImportCaptures) {
    if (cap.name === 'import.default_name') {
      currentDefaultName = cap.node.text
    } else if (cap.name === 'import.source') {
      const source = stripQuotes(cap.node.text)
      const resolvedPath = resolveImportSource(source, filepath, sourceRoot)
      if (resolvedPath) {
        const importedFileId = entityId('file', resolvedPath, resolvedPath)
        edges.push({
          type: 'imports',
          sourceId: fileId,
          targetId: importedFileId,
          meta: { symbol: 'default' },
        })
        // Default import: the local name maps to the source file
        if (currentDefaultName) {
          importSymbolMap.set(currentDefaultName, resolvedPath)
        }
      }
    }
  }

  const nsImportCaptures = runQuery(tsLanguage, NAMESPACE_IMPORT_QUERY, rootNode)
  let currentNsName = ''
  for (const cap of nsImportCaptures) {
    if (cap.name === 'import.namespace_name') {
      currentNsName = cap.node.text
    } else if (cap.name === 'import.source') {
      const source = stripQuotes(cap.node.text)
      const resolvedPath = resolveImportSource(source, filepath, sourceRoot)
      if (resolvedPath) {
        const importedFileId = entityId('file', resolvedPath, resolvedPath)
        edges.push({
          type: 'imports',
          sourceId: fileId,
          targetId: importedFileId,
          meta: { symbol: '*' },
        })
        // Namespace import: record for method-style cross-file resolution (ns.foo())
        if (currentNsName) {
          importSymbolMap.set(currentNsName, resolvedPath)
        }
      }
    }
  }

  // --- Extract call edges (intra-file + cross-file resolution) ---
  const callCaptures = runQuery(tsLanguage, CALL_EXPRESSION_QUERY, rootNode)
  for (const cap of callCaptures) {
    if (cap.name === 'call.func_name') {
      // Direct call: bar()
      const calleeName = cap.node.text
      const callNode = cap.node.parent! // call_expression
      const line = callNode.startPosition.row + 1

      // Try local resolution first
      let calleeId = resolveCallTarget(calleeName, filepath, entitySet)

      // Cross-file: if the callee was imported, resolve to the target file
      if (!calleeId) {
        const targetFile = importSymbolMap.get(calleeName)
        if (targetFile) {
          // Construct the entity ID — try function first (most common for imported symbols)
          calleeId = entityId('function', targetFile, calleeName)
        }
      }

      if (!calleeId) continue

      const callerId = findEnclosingEntity(cap.node, filepath, entitySet) ?? fileId
      edges.push({
        type: 'calls',
        sourceId: callerId,
        targetId: calleeId,
        meta: { siteLine: line },
      })
    } else if (cap.name === 'call.method_name') {
      // Method call: foo.bar()
      const methodName = cap.node.text
      const memberExpr = cap.node.parent! // member_expression
      const callNode = memberExpr.parent! // call_expression
      const line = callNode.startPosition.row + 1

      // Get the object: the part before the dot
      const objectNode = memberExpr.childForFieldName('object')
      const objectName = objectNode?.type === 'identifier' ? objectNode.text : null

      // Try local resolution first (same-file method)
      let calleeId = resolveCallTarget(methodName, filepath, entitySet)

      // Cross-file: if the object was imported (namespace import or default class)
      if (!calleeId && objectName) {
        const targetFile = importSymbolMap.get(objectName)
        if (targetFile) {
          // Try as a function in the target file
          calleeId = entityId('function', targetFile, methodName)
        }
      }

      if (!calleeId) continue

      const callerId = findEnclosingEntity(cap.node, filepath, entitySet) ?? fileId
      edges.push({
        type: 'calls',
        sourceId: callerId,
        targetId: calleeId,
        meta: { siteLine: line },
      })
    }
  }

  // --- Extract extends edges ---
  const extendsCaptures = runQuery(tsLanguage, EXTENDS_CLAUSE_QUERY, rootNode)
  let extendsChild = ''
  for (const cap of extendsCaptures) {
    if (cap.name === 'extends.child') {
      extendsChild = cap.node.text
    } else if (cap.name === 'extends.parent') {
      const childId = classIds.get(extendsChild)
      const parentId = classIds.get(cap.node.text)
      if (childId && parentId) {
        edges.push({
          type: 'extends',
          sourceId: childId,
          targetId: parentId,
        })
      }
    }
  }

  // --- Extract implements edges ---
  const implCaptures = runQuery(tsLanguage, IMPLEMENTS_CLAUSE_QUERY, rootNode)
  let implClass = ''
  for (const cap of implCaptures) {
    if (cap.name === 'impl.class') {
      implClass = cap.node.text
    } else if (cap.name === 'impl.interface') {
      const classId = classIds.get(implClass)
      const ifaceId = entityId('interface', filepath, cap.node.text)
      if (classId && entitySet.has(ifaceId)) {
        edges.push({
          type: 'implements',
          sourceId: classId,
          targetId: ifaceId,
        })
      }
    }
  }

  // --- Extract env var reads ---
  extractEnvReads(tsLanguage, rootNode, filepath, entitySet, envReads)

  return { filepath, entities, edges, envReads, constructorDeps, functionDeps }
}

/**
 * Extract formal parameters from a function/method/arrow node.
 * Returns array of { paramName, paramType, position }.
 */
function extractParams(node: Node): Array<{ paramName: string; paramType: string | null; position: number }> {
  const params: Array<{ paramName: string; paramType: string | null; position: number }> = []
  const formalParams = node.childForFieldName('parameters')
  if (!formalParams) return params

  let position = 0
  for (let i = 0; i < formalParams.namedChildCount; i++) {
    const param = formalParams.namedChild(i)
    if (!param) continue
    if (param.type !== 'required_parameter' && param.type !== 'optional_parameter') continue

    const nameNode = param.childForFieldName('pattern')
    if (!nameNode) continue

    const typeAnnotation = param.childForFieldName('type')
    let paramType: string | null = null
    if (typeAnnotation) {
      // type_annotation has a child that is the actual type node
      const typeNode = typeAnnotation.namedChildCount > 0 ? typeAnnotation.namedChild(0) : null
      paramType = typeNode?.text ?? null
    }

    params.push({
      paramName: nameNode.text,
      paramType,
      position,
    })
    position++
  }

  return params
}

/**
 * Extract paramsText and returnText from a function/method/arrow node.
 */
function extractSignature(node: Node): { paramsText: string | null; returnText: string | null } {
  let paramsText: string | null = null
  let returnText: string | null = null

  const formalParams = node.childForFieldName('parameters')
  if (formalParams) {
    paramsText = formalParams.text
  }

  const returnType = node.childForFieldName('return_type')
  if (returnType) {
    // return_type is a type_annotation node — get the inner type text
    const typeNode = returnType.namedChildCount > 0 ? returnType.namedChild(0) : null
    returnText = typeNode?.text ?? returnType.text.replace(/^:\s*/, '')
  }

  return { paramsText, returnText }
}

/**
 * Extract env var reads from source tree.
 * Detects process.env.X, Bun.env.X, import.meta.env.X patterns.
 */
function extractEnvReads(
  language: Language,
  rootNode: Node,
  filepath: string,
  knownEntities: Set<string>,
  envReads: EnvRead[],
): void {
  const envAccessors = new Set(['process', 'Bun'])

  // process.env.VAR_NAME / Bun.env.VAR_NAME
  const memberCaptures = runQuery(language, ENV_MEMBER_QUERY, rootNode)
  for (let i = 0; i < memberCaptures.length; i++) {
    const cap = memberCaptures[i]
    if (cap.name === 'env.obj') {
      const obj = cap.node.text
      const prop = memberCaptures[i + 1]?.node.text
      const varNameCap = memberCaptures[i + 2]
      if (prop === 'env' && envAccessors.has(obj) && varNameCap?.name === 'env.var_name') {
        const enclosing = findEnclosingEntity(cap.node, filepath, knownEntities)
        if (enclosing) {
          envReads.push({
            entityId: enclosing,
            varName: varNameCap.node.text,
            filepath,
            line: cap.node.startPosition.row + 1,
            accessor: `${obj}.env`,
          })
        }
      }
    }
  }

  // process.env['VAR_NAME']
  const subscriptCaptures = runQuery(language, ENV_SUBSCRIPT_QUERY, rootNode)
  for (let i = 0; i < subscriptCaptures.length; i++) {
    const cap = subscriptCaptures[i]
    if (cap.name === 'env.obj') {
      const obj = cap.node.text
      const prop = subscriptCaptures[i + 1]?.node.text
      const varNameCap = subscriptCaptures[i + 2]
      if (prop === 'env' && envAccessors.has(obj) && varNameCap?.name === 'env.var_name') {
        const enclosing = findEnclosingEntity(cap.node, filepath, knownEntities)
        if (enclosing) {
          envReads.push({
            entityId: enclosing,
            varName: stripQuotes(varNameCap.node.text),
            filepath,
            line: cap.node.startPosition.row + 1,
            accessor: `${obj}.env`,
          })
        }
      }
    }
  }

  // const { VAR_A, VAR_B } = process.env
  const destructureCaptures = runQuery(language, ENV_DESTRUCTURE_QUERY, rootNode)
  for (let i = 0; i < destructureCaptures.length; i++) {
    const cap = destructureCaptures[i]
    if (cap.name === 'env.var_name') {
      // Look ahead for obj and prop
      let objCap: CaptureResult | undefined
      let propCap: CaptureResult | undefined
      for (let j = i + 1; j < destructureCaptures.length; j++) {
        if (destructureCaptures[j].name === 'env.obj') { objCap = destructureCaptures[j]; break }
      }
      for (let j = i + 1; j < destructureCaptures.length; j++) {
        if (destructureCaptures[j].name === 'env.prop') { propCap = destructureCaptures[j]; break }
      }
      if (objCap && propCap && propCap.node.text === 'env' && envAccessors.has(objCap.node.text)) {
        const enclosing = findEnclosingEntity(cap.node, filepath, knownEntities)
        if (enclosing) {
          envReads.push({
            entityId: enclosing,
            varName: cap.node.text,
            filepath,
            line: cap.node.startPosition.row + 1,
            accessor: `${objCap.node.text}.env`,
          })
        }
      }
    }
  }
}

/**
 * Walk up from a node to find the nearest enclosing function/method/class entity.
 * Returns the entity ID if found, null otherwise.
 */
function findEnclosingEntity(
  node: Node,
  filepath: string,
  knownEntities: Set<string>
): string | null {
  let current = node.parent
  while (current) {
    if (current.type === 'method_definition') {
      const methodName = current.childForFieldName('name')?.text
      const classNode = current.parent?.parent // class_body → class_declaration
      const className = classNode?.childForFieldName('name')?.text
      if (className && methodName) {
        const id = entityId('method', filepath, `${className}.${methodName}`)
        if (knownEntities.has(id)) return id
      }
    }
    if (current.type === 'function_declaration') {
      const name = current.childForFieldName('name')?.text
      if (name) {
        const id = entityId('function', filepath, name)
        if (knownEntities.has(id)) return id
      }
    }
    if (current.type === 'class_declaration') {
      const name = current.childForFieldName('name')?.text
      if (name) {
        const id = entityId('class', filepath, name)
        if (knownEntities.has(id)) return id
      }
    }
    if (current.type === 'variable_declarator') {
      // Arrow function: const foo = () => {}
      const name = current.childForFieldName('name')?.text
      if (name) {
        const id = entityId('function', filepath, name)
        if (knownEntities.has(id)) return id
      }
    }
    current = current.parent
  }
  return null
}
