/**
 * Tree-sitter Query Strings
 *
 * S-expression patterns for extracting entities and relationships
 * from TypeScript/JavaScript source code. These patterns use tree-sitter's
 * query syntax with @captures for named extraction points.
 *
 * Note: The same queries work for TS and JS grammars since tree-sitter-typescript
 * extends tree-sitter-javascript's grammar. TSX extends TS similarly.
 */

// --- Entity Extraction Queries ---

/** Class declarations: `class Foo { ... }` and `export class Foo { ... }` */
export const CLASS_QUERY = `
  (class_declaration
    name: (type_identifier) @class.name
  ) @class.def
`

/** Function declarations: `function foo() {}` and `export function foo() {}` */
export const FUNCTION_DECLARATION_QUERY = `
  (function_declaration
    name: (identifier) @func.name
  ) @func.def
`

/**
 * Arrow functions assigned to variables:
 * `const foo = () => {}` / `const foo = async () => {}`
 */
export const ARROW_FUNCTION_QUERY = `
  (lexical_declaration
    (variable_declarator
      name: (identifier) @arrow.name
      value: (arrow_function) @arrow.value
    )
  ) @arrow.def
`

/** Method definitions inside class bodies */
export const METHOD_QUERY = `
  (class_declaration
    name: (type_identifier) @method.class_name
    body: (class_body
      (method_definition
        name: (property_identifier) @method.name
      ) @method.def
    )
  )
`

/** Interface declarations: `interface Foo { ... }` */
export const INTERFACE_QUERY = `
  (interface_declaration
    name: (type_identifier) @iface.name
  ) @iface.def
`

/** Type alias declarations: `type Foo = ...` */
export const TYPE_ALIAS_QUERY = `
  (type_alias_declaration
    name: (type_identifier) @type.name
  ) @type.def
`

/** Enum declarations: `enum Foo { ... }` */
export const ENUM_QUERY = `
  (enum_declaration
    name: (identifier) @enum.name
  ) @enum.def
`

// --- Relationship Extraction Queries ---

/** Import statements with named imports: `import { Foo } from './bar'` */
export const NAMED_IMPORT_QUERY = `
  (import_statement
    (import_clause
      (named_imports
        (import_specifier
          name: (identifier) @import.name
        )
      )
    )
    source: (string) @import.source
  )
`

/** Import statements with default import: `import Foo from './bar'` */
export const DEFAULT_IMPORT_QUERY = `
  (import_statement
    (import_clause
      (identifier) @import.default_name
    )
    source: (string) @import.source
  )
`

/** Namespace/star imports: `import * as Foo from './bar'` */
export const NAMESPACE_IMPORT_QUERY = `
  (import_statement
    (import_clause
      (namespace_import
        (identifier) @import.namespace_name
      )
    )
    source: (string) @import.source
  )
`

/** Call expressions — function/method calls */
export const CALL_EXPRESSION_QUERY = `
  (call_expression
    function: [
      (identifier) @call.func_name
      (member_expression
        property: (property_identifier) @call.method_name
      )
    ]
  ) @call.def
`

/** Extends clause: `class Foo extends Bar` */
export const EXTENDS_CLAUSE_QUERY = `
  (class_declaration
    name: (type_identifier) @extends.child
    (class_heritage
      (extends_clause
        value: (identifier) @extends.parent
      )
    )
  )
`

/** Implements clause: `class Foo implements Bar, Baz` */
export const IMPLEMENTS_CLAUSE_QUERY = `
  (class_declaration
    name: (type_identifier) @impl.class
    (class_heritage
      (implements_clause
        (type_identifier) @impl.interface
      )
    )
  )
`

/**
 * Export declarations — used to mark entities as exported.
 * We don't extract these as entities; instead we check parent nodes.
 */
export const EXPORT_QUERY = `
  (export_statement) @export.def
`

// --- Test Health Queries ---

/**
 * Formal parameters of functions and methods.
 * Captures the parameter name and optional type annotation.
 */
export const REQUIRED_PARAM_QUERY = `
  (required_parameter
    pattern: (identifier) @param.name
    type: (type_annotation (_) @param.type)?
  ) @param.def
`

/**
 * Optional parameters: `foo?: string`
 */
export const OPTIONAL_PARAM_QUERY = `
  (optional_parameter
    pattern: (identifier) @param.name
    type: (type_annotation (_) @param.type)?
  ) @param.def
`

/**
 * Env var access via member expression: `process.env.VAR_NAME` / `Bun.env.VAR_NAME`
 */
export const ENV_MEMBER_QUERY = `
  (member_expression
    object: (member_expression
      object: (identifier) @env.obj
      property: (property_identifier) @env.prop
    )
    property: (property_identifier) @env.var_name
  ) @env.access
`

/**
 * Env var access via subscript: `process.env['VAR_NAME']` / `process.env["VAR_NAME"]`
 */
export const ENV_SUBSCRIPT_QUERY = `
  (subscript_expression
    object: (member_expression
      object: (identifier) @env.obj
      property: (property_identifier) @env.prop
    )
    index: (string) @env.var_name
  ) @env.access
`

/**
 * Destructured env vars: `const { VAR_A, VAR_B } = process.env`
 */
export const ENV_DESTRUCTURE_QUERY = `
  (variable_declarator
    name: (object_pattern
      (shorthand_property_identifier_pattern) @env.var_name
    )
    value: (member_expression
      object: (identifier) @env.obj
      property: (property_identifier) @env.prop
    )
  ) @env.access
`

/**
 * Return type annotations on functions:
 * `function foo(): ReturnType { ... }`
 * `const foo = (): ReturnType => { ... }`
 */
export const FUNCTION_RETURN_TYPE_QUERY = `
  (function_declaration
    name: (identifier) @ret.func_name
    return_type: (type_annotation (_) @ret.type)
  )
`

export const ARROW_RETURN_TYPE_QUERY = `
  (lexical_declaration
    (variable_declarator
      name: (identifier) @ret.func_name
      value: (arrow_function
        return_type: (type_annotation (_) @ret.type)
      )
    )
  )
`

export const METHOD_RETURN_TYPE_QUERY = `
  (class_declaration
    name: (type_identifier) @ret.class_name
    body: (class_body
      (method_definition
        name: (property_identifier) @ret.method_name
        return_type: (type_annotation (_) @ret.type)
      )
    )
  )
`
