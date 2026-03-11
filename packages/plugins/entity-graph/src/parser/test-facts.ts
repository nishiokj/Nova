import type { Node } from 'web-tree-sitter'
import type {
  IndexedTestCase,
  IndexedTestCaseAssertion,
  IndexedTestCaseCall,
  IndexedTestCaseImport,
  IndexedTestCaseMock,
  IndexedTestCaseSeamOverride,
  TestAssertionKind,
} from '../types.js'
import { isLikelyTestPath, resolveImportSource, stripQuotes } from './shared.js'

interface ImportEntry {
  kind: 'named' | 'default' | 'namespace'
  localName: string
  importedName: string
  resolvedPath: string | null
  isProd: boolean
}

interface ExtractedTestFacts {
  testCases: IndexedTestCase[]
  testCaseImports: IndexedTestCaseImport[]
  testCaseCalls: IndexedTestCaseCall[]
  testCaseAssertions: IndexedTestCaseAssertion[]
  testCaseMocks: IndexedTestCaseMock[]
  testCaseSeamOverrides: IndexedTestCaseSeamOverride[]
}

interface InvocationInfo {
  importedSymbol?: string
  resolvedPath?: string | null
  helperName?: string
}

interface AssertionFactInfo {
  kind: TestAssertionKind
  targetSymbol: string | null
  resolvedPath: string | null
}

const TEST_FRAMEWORK_ROOTS = new Set([
  'afterAll',
  'afterEach',
  'beforeAll',
  'beforeEach',
  'describe',
  'expect',
  'it',
  'jest',
  'test',
  'vi',
])

const MOCK_INTERACTION_MATCHERS = new Set([
  'toBeCalled',
  'toBeCalledTimes',
  'toBeCalledWith',
  'toHaveBeenCalled',
  'toHaveBeenCalledOnce',
  'toHaveBeenCalledTimes',
  'toHaveBeenCalledWith',
  'toHaveBeenLastCalledWith',
  'toHaveBeenNthCalledWith',
  'toHaveBeenCalledBefore',
  'toHaveReturned',
  'toHaveReturnedTimes',
  'toHaveReturnedWith',
  'toHaveLastReturnedWith',
  'toHaveNthReturnedWith',
])

const ORDERING_MATCHERS = new Set([
  'toHaveBeenCalledBefore',
  'toHaveBeenLastCalledWith',
  'toHaveBeenNthCalledWith',
  'toHaveLastReturnedWith',
  'toHaveNthReturnedWith',
])

const EXISTENCE_MATCHERS = new Set([
  'toBeDefined',
  'toBeFalsy',
  'toBeNull',
  'toBeTruthy',
  'toBeUndefined',
])

const ERROR_MATCHERS = new Set([
  'toThrow',
  'toThrowError',
])

const STUB_APIS = new Set([
  'mockImplementation',
  'mockImplementationOnce',
  'mockRejectedValue',
  'mockRejectedValueOnce',
  'mockResolvedValue',
  'mockResolvedValueOnce',
  'mockReturnValue',
  'mockReturnValueOnce',
])

export function extractTestFacts(
  rootNode: Node,
  filepath: string,
  sourceRoot: string,
): ExtractedTestFacts {
  if (!isLikelyTestPath(filepath)) {
    return emptyFacts()
  }

  const imports = collectImports(rootNode, filepath, sourceRoot)
  const importsByLocalName = new Map(imports.map(entry => [entry.localName, entry]))
  const testCases: IndexedTestCase[] = []
  const testCaseImports: IndexedTestCaseImport[] = []
  const testCaseCalls: IndexedTestCaseCall[] = []
  const testCaseAssertions: IndexedTestCaseAssertion[] = []
  const testCaseMocks: IndexedTestCaseMock[] = []
  const testCaseSeamOverrides: IndexedTestCaseSeamOverride[] = []

  walk(rootNode, node => {
    if (node.type !== 'call_expression') return
    if (!isTestCaseCall(node)) return
    if (!getCallbackNode(node)) return

    const analyzed = analyzeTestCase(node, filepath, importsByLocalName)
    testCases.push(analyzed.testCase)
    testCaseImports.push(...analyzed.testCaseImports)
    testCaseCalls.push(...analyzed.testCaseCalls)
    testCaseAssertions.push(...analyzed.testCaseAssertions)
    testCaseMocks.push(...analyzed.testCaseMocks)
    testCaseSeamOverrides.push(...analyzed.testCaseSeamOverrides)
  })

  return {
    testCases,
    testCaseImports,
    testCaseCalls,
    testCaseAssertions,
    testCaseMocks,
    testCaseSeamOverrides,
  }
}

function emptyFacts(): ExtractedTestFacts {
  return {
    testCases: [],
    testCaseImports: [],
    testCaseCalls: [],
    testCaseAssertions: [],
    testCaseMocks: [],
    testCaseSeamOverrides: [],
  }
}

function analyzeTestCase(
  callNode: Node,
  filepath: string,
  importsByLocalName: Map<string, ImportEntry>,
): {
  testCase: IndexedTestCase
  testCaseImports: IndexedTestCaseImport[]
  testCaseCalls: IndexedTestCaseCall[]
  testCaseAssertions: IndexedTestCaseAssertion[]
  testCaseMocks: IndexedTestCaseMock[]
  testCaseSeamOverrides: IndexedTestCaseSeamOverride[]
} {
  const name = buildTestName(callNode)
  const testCaseId = buildTestCaseId(filepath, callNode, name)
  const testCase: IndexedTestCase = {
    id: testCaseId,
    filepath,
    name,
    lineStart: callNode.startPosition.row + 1,
    lineEnd: callNode.endPosition.row + 1,
  }

  const prodResultAliases = new Map<string, { symbol: string | null; resolvedPath: string | null }>()
  const mockAliases = new Set<string>()
  const usedImports = new Map<string, IndexedTestCaseImport>()
  const testCaseCalls: IndexedTestCaseCall[] = []
  const testCaseAssertions: IndexedTestCaseAssertion[] = []
  const testCaseMocks: IndexedTestCaseMock[] = []
  const testCaseSeamOverrides: IndexedTestCaseSeamOverride[] = []

  const callback = getCallbackNode(callNode)
  const body = callback ? getFunctionBodyNode(callback) : null
  if (body) {
    walk(body, node => {
      if (node.type === 'identifier') {
        const entry = importsByLocalName.get(node.text)
        if (entry?.isProd) {
          usedImports.set(node.text, {
            testCaseId,
            localName: entry.localName,
            importedName: entry.importedName,
            resolvedPath: entry.resolvedPath,
            isProd: entry.isProd,
          })
        }
        return
      }

      if (node.type === 'variable_declarator') {
        const bindingName = getBindingIdentifier(node)
        const initializer = unwrapExpression(node.namedChild(1) ?? null)
        if (bindingName && initializer) {
          const mockSite = parseMockSite(initializer, testCaseId)
          if (mockSite) mockAliases.add(bindingName)

          const invocation = parseInvocation(initializer, importsByLocalName)
          if (invocation?.importedSymbol) {
            prodResultAliases.set(bindingName, {
              symbol: invocation.importedSymbol,
              resolvedPath: invocation.resolvedPath ?? null,
            })
          }
        }
        return
      }

      if (node.type === 'assignment_expression') {
        const left = unwrapExpression(node.namedChild(0) ?? null)
        const envVar = parseEnvVar(left)
        if (envVar) {
          testCaseSeamOverrides.push({
            testCaseId,
            kind: 'env',
            target: envVar,
            line: node.startPosition.row + 1,
          })
          return
        }

        const globalTarget = parseGlobalTarget(left)
        if (globalTarget) {
          testCaseSeamOverrides.push({
            testCaseId,
            kind: 'global',
            target: globalTarget,
            line: node.startPosition.row + 1,
          })
        }
        return
      }

      if (node.type !== 'call_expression' && node.type !== 'new_expression') return

      const invocation = parseInvocation(node, importsByLocalName)
      if (invocation?.importedSymbol) {
        testCaseCalls.push({
          testCaseId,
          kind: 'imported',
          symbol: invocation.importedSymbol,
          resolvedPath: invocation.resolvedPath ?? null,
          line: node.startPosition.row + 1,
        })
      } else if (invocation?.helperName) {
        testCaseCalls.push({
          testCaseId,
          kind: 'helper',
          symbol: invocation.helperName,
          resolvedPath: null,
          line: node.startPosition.row + 1,
        })
      }

      const mockSite = parseMockSite(node, testCaseId)
      if (mockSite) testCaseMocks.push(mockSite)

      const seamOverride = parseTimerOverride(node, testCaseId)
      if (seamOverride) testCaseSeamOverrides.push(seamOverride)

      const assertion = classifyAssertion(node, importsByLocalName, prodResultAliases, mockAliases)
      if (assertion) {
        testCaseAssertions.push({
          testCaseId,
          kind: assertion.kind,
          targetSymbol: assertion.targetSymbol,
          resolvedPath: assertion.resolvedPath,
          line: node.startPosition.row + 1,
        })
      }
    })
  }

  return {
    testCase,
    testCaseImports: [...usedImports.values()],
    testCaseCalls,
    testCaseAssertions,
    testCaseMocks,
    testCaseSeamOverrides,
  }
}

function collectImports(rootNode: Node, currentFilepath: string, sourceRoot: string): ImportEntry[] {
  const imports: ImportEntry[] = []

  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const node = rootNode.namedChild(i)
    if (!node) continue
    if (node.type !== 'import_statement') continue

    const sourceNode = findNamedChild(node, 'string')
    const source = sourceNode ? stripQuotes(sourceNode.text) : ''
    const resolvedPath = resolveImportSource(source, currentFilepath, sourceRoot)
    const isProd = resolvedPath !== null && !isLikelyTestPath(resolvedPath)
    const clause = findNamedChild(node, 'import_clause')
    if (!clause) continue

    for (let j = 0; j < clause.namedChildCount; j++) {
      const child = clause.namedChild(j)
      if (!child) continue
      if (child.type === 'identifier') {
        imports.push({
          kind: 'default',
          localName: child.text,
          importedName: child.text,
          resolvedPath,
          isProd,
        })
        continue
      }

      if (child.type === 'named_imports') {
        for (let k = 0; k < child.namedChildCount; k++) {
          const specifier = child.namedChild(k)
          if (!specifier) continue
          if (specifier.type !== 'import_specifier') continue
          const importedName = specifier.namedChild(0)?.text ?? ''
          const alias = specifier.namedChild(1)?.text
          imports.push({
            kind: 'named',
            localName: alias ?? importedName,
            importedName,
            resolvedPath,
            isProd,
          })
        }
        continue
      }

      if (child.type === 'namespace_import') {
        const identifier = child.namedChild(0)
        if (!identifier) continue
        imports.push({
          kind: 'namespace',
          localName: identifier.text,
          importedName: identifier.text,
          resolvedPath,
          isProd,
        })
      }
    }
  }

  return imports
}

function buildTestCaseId(filepath: string, node: Node, name: string): string {
  return `testcase:${filepath}:${node.startPosition.row + 1}:${node.endPosition.row + 1}:${name}`
}

function buildTestName(node: Node): string {
  const labels = collectAncestorDescribeLabels(node)
  const label = getCallLabel(node)
  return [...labels, label].filter(Boolean).join(' > ') || 'anonymous test'
}

function collectAncestorDescribeLabels(node: Node): string[] {
  const labels: string[] = []
  let current = node.parent
  while (current) {
    if (current.type === 'call_expression' && isDescribeCall(current)) {
      labels.push(getCallLabel(current))
    }
    current = current.parent
  }
  return labels.reverse()
}

function classifyAssertion(
  node: Node,
  importsByLocalName: Map<string, ImportEntry>,
  prodResultAliases: Map<string, { symbol: string | null; resolvedPath: string | null }>,
  mockAliases: Set<string>,
): AssertionFactInfo | null {
  if (node.type !== 'call_expression') return null

  const chain = getInvocationChain(node)
  if (chain.length < 2 || chain[0] !== 'expect') return null

  const matcher = chain[chain.length - 1]
  const expectCall = findExpectCall(node)
  const expectArg = expectCall ? getArgumentNodes(expectCall)[0] ?? null : null

  if (ERROR_MATCHERS.has(matcher) || chain.includes('rejects')) return { kind: 'error', targetSymbol: null, resolvedPath: null }
  if (ORDERING_MATCHERS.has(matcher)) return { kind: 'ordering', targetSymbol: null, resolvedPath: null }
  if (MOCK_INTERACTION_MATCHERS.has(matcher)) return { kind: 'mock-interaction', targetSymbol: null, resolvedPath: null }
  if (EXISTENCE_MATCHERS.has(matcher)) return { kind: 'existence', targetSymbol: null, resolvedPath: null }

  if (expectArg && referencesIdentifier(expectArg, mockAliases)) {
    return { kind: 'mock-interaction', targetSymbol: null, resolvedPath: null }
  }

  const aliasMatch = expectArg ? findReferencedAlias(expectArg, prodResultAliases) : null
  if (aliasMatch) {
    return {
      kind: 'return-value',
      targetSymbol: aliasMatch.symbol,
      resolvedPath: aliasMatch.resolvedPath,
    }
  }

  const anchoredInvocation = expectArg ? parseInvocation(expectArg, importsByLocalName) : null
  if (anchoredInvocation?.importedSymbol) {
    return {
      kind: 'return-value',
      targetSymbol: anchoredInvocation.importedSymbol,
      resolvedPath: anchoredInvocation.resolvedPath ?? null,
    }
  }

  if (expectArg && looksLikeSideEffectProbe(expectArg, importsByLocalName)) {
    return { kind: 'side-effect', targetSymbol: null, resolvedPath: null }
  }
  if (expectArg && isCleanupProbe(expectArg)) {
    return { kind: 'cleanup', targetSymbol: null, resolvedPath: null }
  }

  return { kind: 'state', targetSymbol: null, resolvedPath: null }
}

function parseInvocation(
  node: Node,
  importsByLocalName: Map<string, ImportEntry>,
): InvocationInfo | null {
  const chain = getInvocationChain(node)
  if (chain.length === 0) return null

  const rootName = chain[0]
  if (TEST_FRAMEWORK_ROOTS.has(rootName)) return null

  const imported = importsByLocalName.get(rootName)
  if (!imported?.isProd) {
    return {
      helperName: chain.join('.'),
    }
  }

  return {
    importedSymbol: imported.kind === 'namespace' ? chain[chain.length - 1] ?? imported.importedName : imported.importedName,
    resolvedPath: imported.resolvedPath,
  }
}

function parseMockSite(node: Node, testCaseId: string): IndexedTestCaseMock | null {
  const chain = getInvocationChain(node)
  if (chain.length === 0) return null

  const api = chain.join('.')
  const last = chain[chain.length - 1]
  const line = node.startPosition.row + 1

  if (api === 'vi.mock' || api === 'jest.mock') {
    return {
      testCaseId,
      kind: 'module-mock',
      api,
      target: stringValue(getArgumentNodes(node)[0] ?? null) || null,
      line,
    }
  }

  if (api === 'vi.spyOn' || api === 'jest.spyOn') {
    return {
      testCaseId,
      kind: 'spy',
      api,
      target: getArgumentNodes(node)[0]?.text ?? null,
      line,
    }
  }

  if (api === 'vi.fn' || api === 'jest.fn') {
    return {
      testCaseId,
      kind: 'mock-factory',
      api,
      target: null,
      line,
    }
  }

  if (STUB_APIS.has(last)) {
    return {
      testCaseId,
      kind: 'stub',
      api,
      target: chain.slice(0, -1).join('.'),
      line,
    }
  }

  return null
}

function parseTimerOverride(node: Node, testCaseId: string): IndexedTestCaseSeamOverride | null {
  const api = getInvocationChain(node).join('.')
  if (
    api === 'vi.useFakeTimers'
    || api === 'jest.useFakeTimers'
    || api === 'vi.setSystemTime'
    || api === 'jest.setSystemTime'
  ) {
    return {
      testCaseId,
      kind: 'timer',
      target: api,
      line: node.startPosition.row + 1,
    }
  }

  return null
}

function parseEnvVar(node: Node | null): string | null {
  if (!node) return null
  const chain = collectMemberChain(node)
  if (chain.length >= 3 && ((chain[0] === 'process' && chain[1] === 'env') || (chain[0] === 'Bun' && chain[1] === 'env'))) {
    return chain[2] ?? null
  }
  return null
}

function parseGlobalTarget(node: Node | null): string | null {
  if (!node) return null
  const chain = collectMemberChain(node)
  if (chain.length < 2) return null

  if (chain[0] === 'global' || chain[0] === 'globalThis' || chain[0] === 'window' || chain[0] === 'document') {
    return chain.join('.')
  }
  if (chain[0] === 'Date' || chain[0] === 'Math') {
    return chain.join('.')
  }

  return null
}

function looksLikeSideEffectProbe(node: Node, importsByLocalName: Map<string, ImportEntry>): boolean {
  let sideEffect = false
  walk(node, current => {
    if (current.type !== 'call_expression' && current.type !== 'new_expression') return
    const invocation = parseInvocation(current, importsByLocalName)
    if (invocation?.helperName || invocation?.importedSymbol) sideEffect = true
  })
  return sideEffect
}

function isCleanupProbe(node: Node): boolean {
  let cleanup = false
  walk(node, current => {
    if (current.type !== 'call_expression') return
    const last = getInvocationChain(current).at(-1) ?? ''
    if (
      last === 'cleanup'
      || last === 'close'
      || last === 'disconnect'
      || last === 'dispose'
      || last === 'restore'
      || last === 'teardown'
    ) {
      cleanup = true
    }
  })
  return cleanup
}

function referencesIdentifier(node: Node, identifiers: Set<string>): boolean {
  let found = false
  walk(node, current => {
    if (current.type === 'identifier' && identifiers.has(current.text)) {
      found = true
    }
  })
  return found
}

function findReferencedAlias(
  node: Node,
  aliases: Map<string, { symbol: string | null; resolvedPath: string | null }>,
): { symbol: string | null; resolvedPath: string | null } | null {
  let match: { symbol: string | null; resolvedPath: string | null } | null = null
  walk(node, current => {
    if (match || current.type !== 'identifier') return
    const found = aliases.get(current.text)
    if (found) match = found
  })
  return match
}

function isTestCaseCall(node: Node): boolean {
  const chain = getInvocationChain(node)
  return chain[0] === 'test' || chain[0] === 'it'
}

function isDescribeCall(node: Node): boolean {
  const chain = getInvocationChain(node)
  return chain[0] === 'describe'
}

function getCallLabel(node: Node): string {
  return stringValue(getArgumentNodes(node)[0] ?? null)
}

function getCallbackNode(node: Node): Node | null {
  const args = getArgumentNodes(node)
  for (let index = args.length - 1; index >= 0; index--) {
    const arg = args[index]
    if (arg.type === 'arrow_function' || arg.type === 'function_expression') return arg
  }
  return null
}

function getFunctionBodyNode(node: Node): Node {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (!child) continue
    if (child.type === 'statement_block') return child
  }
  return node
}

function getArgumentNodes(node: Node): Node[] {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child || child.type !== 'arguments') continue
    const args: Node[] = []
    for (let j = 0; j < child.namedChildCount; j++) {
      const arg = child.namedChild(j)
      if (arg) args.push(arg)
    }
    return args
  }
  return []
}

function getBindingIdentifier(node: Node): string | null {
  const first = node.namedChild(0)
  return first?.type === 'identifier' ? first.text : null
}

function unwrapExpression(node: Node | null): Node | null {
  let current = node
  while (
    current
    && (
      current.type === 'await_expression'
      || current.type === 'parenthesized_expression'
      || current.type === 'type_assertion'
      || current.type === 'as_expression'
      || current.type === 'satisfies_expression'
      || current.type === 'non_null_expression'
    )
  ) {
    current = current.namedChild(current.namedChildCount - 1) ?? current
  }
  return current
}

function getInvocationChain(node: Node): string[] {
  const unwrapped = unwrapExpression(node)
  if (!unwrapped) return []
  if (unwrapped.type === 'call_expression') return collectMemberChain(unwrapped.child(0) ?? null)
  if (unwrapped.type === 'new_expression') return collectMemberChain(unwrapped.namedChild(0) ?? null)
  return []
}

function collectMemberChain(node: Node | null): string[] {
  const current = unwrapExpression(node)
  if (!current) return []

  if (current.type === 'identifier' || current.type === 'property_identifier' || current.type === 'private_property_identifier') {
    return [current.text]
  }

  if (current.type === 'member_expression') {
    const objectNode = current.namedChild(0)
    const propertyNode = current.namedChild(current.namedChildCount - 1)
    if (!propertyNode) return collectMemberChain(objectNode)
    return [...collectMemberChain(objectNode), propertyNode.text]
  }

  if (current.type === 'subscript_expression') {
    const objectNode = current.namedChild(0)
    const indexNode = current.namedChild(1)
    const chain = collectMemberChain(objectNode)
    if (!indexNode) return chain
    const indexValue = stringValue(indexNode)
    return indexValue ? [...chain, indexValue] : chain
  }

  if (current.type === 'call_expression') return collectMemberChain(current.child(0) ?? null)

  return []
}

function findExpectCall(node: Node): Node | null {
  const current = unwrapExpression(node)
  if (!current) return null

  if (current.type === 'call_expression') {
    const chain = getInvocationChain(current)
    if (chain.length === 1 && chain[0] === 'expect') return current
    const functionNode = current.child(0)
    return functionNode ? findExpectCall(functionNode) : null
  }

  if (current.type === 'member_expression') {
    const objectNode = current.namedChild(0)
    return objectNode ? findExpectCall(objectNode) : null
  }

  return null
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node)
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child) walk(child, visit)
  }
}

function findNamedChild(node: Node, type: string): Node | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (!child) continue
    if (child.type === type) return child
  }
  return null
}

function stringValue(node: Node | null): string {
  if (!node) return ''
  return stripQuotes(node.text)
}
