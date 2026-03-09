type JsonSchema = Record<string, unknown>;
type SchemaMode = 'openai' | 'codex';
type JsonSchemaType =
  | 'array'
  | 'boolean'
  | 'integer'
  | 'null'
  | 'number'
  | 'object'
  | 'string';

const SCHEMA_MAP_KEYS = new Set([
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
]);

const schemaIdCache: Record<SchemaMode, Map<string, { source: JsonSchema; compiled: JsonSchema }>> = {
  openai: new Map(),
  codex: new Map(),
};

const schemaRefCache: Record<SchemaMode, WeakMap<object, JsonSchema>> = {
  openai: new WeakMap(),
  codex: new WeakMap(),
};

function isSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transformChildValue(
  value: unknown,
  parentKey: string,
  transform: (schema: JsonSchema) => JsonSchema
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => (isSchemaObject(entry) ? transform(entry) : entry));
  }

  if (!isSchemaObject(value)) {
    return value;
  }

  if (SCHEMA_MAP_KEYS.has(parentKey)) {
    const mapResult: JsonSchema = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      mapResult[childKey] = isSchemaObject(childValue)
        ? transform(childValue)
        : childValue;
    }
    return mapResult;
  }

  return transform(value);
}

function normalizeForOpenAI(schema: JsonSchema): JsonSchema {
  const result: JsonSchema = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema') continue;

    const mappedKey = key === 'oneOf' ? 'anyOf' : key;
    const normalizedValue = transformChildValue(value, key, normalizeForOpenAI);

    if (mappedKey in result && Array.isArray(result[mappedKey]) && Array.isArray(normalizedValue)) {
      result[mappedKey] = [...(result[mappedKey] as unknown[]), ...normalizedValue];
    } else {
      result[mappedKey] = normalizedValue;
    }
  }

  return result;
}

function getConstType(value: unknown): JsonSchema['type'] | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return undefined;
}

function getEnumTypes(values: unknown[]): JsonSchemaType[] {
  const types = values
    .map((value) => getConstType(value))
    .filter((value): value is JsonSchemaType => typeof value === 'string');
  return uniqueValues(types) as JsonSchemaType[];
}

function normalizeTypeList(typeValue: unknown): JsonSchemaType[] {
  if (typeof typeValue === 'string') {
    return [typeValue as JsonSchemaType];
  }
  if (Array.isArray(typeValue)) {
    const types = typeValue.filter((value): value is JsonSchemaType => typeof value === 'string');
    return uniqueValues(types) as JsonSchemaType[];
  }
  return [];
}

function getSchemaTypes(schema: JsonSchema): JsonSchemaType[] {
  const declaredTypes = normalizeTypeList(schema.type);
  if (declaredTypes.length > 0) return declaredTypes;

  if (schema.const !== undefined) {
    const constType = getConstType(schema.const);
    return constType ? [constType as JsonSchemaType] : [];
  }

  if (Array.isArray(schema.enum)) {
    return getEnumTypes(schema.enum);
  }

  return [];
}

function withTypeList(schema: JsonSchema, types: JsonSchemaType[]): JsonSchema {
  const uniqueTypes = uniqueValues(types) as JsonSchemaType[];
  if (uniqueTypes.length === 0) return schema;
  if (uniqueTypes.length === 1) {
    return { ...schema, type: uniqueTypes[0] };
  }
  return { ...schema, type: uniqueTypes };
}

function uniqueValues(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

function mergeWithFallback(primary: JsonSchema, secondary: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...secondary, ...primary };

  if (isSchemaObject(secondary.properties) && isSchemaObject(primary.properties)) {
    out.properties = { ...secondary.properties, ...primary.properties };
  }

  if (Array.isArray(secondary.required) && Array.isArray(primary.required)) {
    out.required = uniqueValues([...(secondary.required as unknown[]), ...(primary.required as unknown[])]);
  }

  return out;
}

function mergeObjectAlternatives(options: JsonSchema[]): JsonSchema {
  const mergedProperties: JsonSchema = {};
  const propertyNames = new Set<string>();

  for (const option of options) {
    if (isSchemaObject(option.properties)) {
      for (const key of Object.keys(option.properties)) {
        propertyNames.add(key);
      }
    }
  }

  for (const propertyName of propertyNames) {
    const propertySchemas = options
      .map((option) => {
        const properties = option.properties;
        if (!isSchemaObject(properties)) return null;
        const propertySchema = properties[propertyName];
        return isSchemaObject(propertySchema) ? propertySchema : null;
      })
      .filter((entry): entry is JsonSchema => entry !== null);

    if (propertySchemas.length > 0) {
      mergedProperties[propertyName] = mergeAlternatives(propertySchemas);
    }
  }

  let requiredIntersection: string[] | null = null;
  for (const option of options) {
    const requiredList = Array.isArray(option.required)
      ? (option.required as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    if (requiredIntersection === null) {
      requiredIntersection = [...requiredList];
    } else {
      const requiredSet = new Set(requiredList);
      requiredIntersection = requiredIntersection.filter((key) => requiredSet.has(key));
    }
  }

  const merged: JsonSchema = {
    type: 'object',
    properties: mergedProperties,
  };

  if (requiredIntersection && requiredIntersection.length > 0) {
    merged.required = requiredIntersection;
  }

  const explicitAdditionalProperties = options
    .map((option) => option.additionalProperties)
    .filter((value) => typeof value === 'boolean');
  if (explicitAdditionalProperties.length > 0) {
    merged.additionalProperties = explicitAdditionalProperties.every(Boolean);
  }

  return merged;
}

function mergeAlternatives(options: JsonSchema[]): JsonSchema {
  if (options.length === 0) return {};
  if (options.length === 1) return options[0];

  const uniqueByShape = uniqueValues(options.map((option) => JSON.stringify(option)));
  if (uniqueByShape.length === 1) {
    return options[0];
  }

  const constValues = options
    .map((option) => option.const)
    .filter((value) => value !== undefined);
  if (constValues.length === options.length) {
    const enumValues = uniqueValues(constValues);
    const constTypes = getEnumTypes(enumValues);
    return withTypeList({ enum: enumValues }, constTypes);
  }

  const enumValues = options
    .flatMap((option) => (Array.isArray(option.enum) ? option.enum : []));
  if (enumValues.length > 0 && enumValues.length === options.reduce((n, option) => n + (Array.isArray(option.enum) ? option.enum.length : 0), 0)) {
    const mergedEnumValues = uniqueValues(enumValues);
    return withTypeList({ enum: mergedEnumValues }, getEnumTypes(mergedEnumValues));
  }

  const objectOptions = options.filter((option) => option.type === 'object' || isSchemaObject(option.properties));
  if (objectOptions.length === options.length) {
    return mergeObjectAlternatives(objectOptions);
  }

  const optionTypes = options.map((option) => getSchemaTypes(option));
  if (optionTypes.every((types) => types.length > 0)) {
    const mergedTypes = uniqueValues(optionTypes.flat()) as JsonSchemaType[];
    const nonNullTypes = mergedTypes.filter((type) => type !== 'null');

    // Normalize nullable single-type unions (e.g. string|null, object|null).
    if (mergedTypes.includes('null') && nonNullTypes.length === 1) {
      const primaryType = nonNullTypes[0];
      const primaryOptions = options.filter((option, index) => optionTypes[index].includes(primaryType));
      if (primaryOptions.length === 1) {
        return withTypeList({ ...primaryOptions[0] }, [primaryType, 'null']);
      }

      if (primaryType === 'object') {
        const mergedObject = mergeObjectAlternatives(primaryOptions);
        return withTypeList(mergedObject, ['object', 'null']);
      }

      // Multiple non-object schemas with same base type; keep first shape and widen type to nullable.
      return withTypeList({ ...primaryOptions[0] }, [primaryType, 'null']);
    }

    return withTypeList({}, mergedTypes);
  }

  return {};
}

function normalizeForCodex(schema: JsonSchema): JsonSchema {
  const base: JsonSchema = {};
  const alternatives: JsonSchema[] = [];

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema') continue;

    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      for (const entry of value) {
        if (isSchemaObject(entry)) {
          alternatives.push(normalizeForCodex(entry));
        }
      }
      continue;
    }

    base[key] = transformChildValue(value, key, normalizeForCodex);
  }

  if (alternatives.length === 0) {
    return base;
  }

  const mergedAlternatives = mergeAlternatives(alternatives);
  return mergeWithFallback(base, mergedAlternatives);
}

function ensureRootObject(schema: JsonSchema): JsonSchema {
  if (schema.type === 'object' && !schema.anyOf && !schema.oneOf && !schema.allOf) {
    return schema;
  }

  return {
    type: 'object',
    properties: { result: schema },
    required: ['result'],
    additionalProperties: false,
  };
}

function compileSchema(schema: JsonSchema, mode: SchemaMode): JsonSchema {
  const normalized = mode === 'openai'
    ? normalizeForOpenAI(schema)
    : normalizeForCodex(schema);
  return ensureRootObject(normalized);
}

function compileWithCache(mode: SchemaMode, schema: JsonSchema, schemaId?: string): JsonSchema {
  if (schemaId) {
    const cachedById = schemaIdCache[mode].get(schemaId);
    if (cachedById?.source === schema) return cachedById.compiled;
  }

  const cachedByRef = schemaRefCache[mode].get(schema);
  if (cachedByRef) return cachedByRef;

  const compiled = compileSchema(schema, mode);

  if (schemaId) {
    schemaIdCache[mode].set(schemaId, { source: schema, compiled });
  }
  schemaRefCache[mode].set(schema, compiled);

  return compiled;
}

export function compileSchemaForOpenAI(schema: JsonSchema, schemaId?: string): JsonSchema {
  return compileWithCache('openai', schema, schemaId);
}

export function compileSchemaForCodex(schema: JsonSchema, schemaId?: string): JsonSchema {
  return compileWithCache('codex', schema, schemaId);
}
