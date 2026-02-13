import { compileSchemaForCodex, compileSchemaForOpenAI } from 'llm/providers/schema_compiler.js';
import { getOutputSchemaJson } from 'shared';

describe('schema_compiler', () => {
  it('converts root combinators for codex/openai modes', () => {
    const schema = {
      anyOf: [
        {
          type: 'object',
          properties: { action: { const: 'done', type: 'string' } },
          required: ['action'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { action: { const: 'continue', type: 'string' } },
          required: ['action'],
          additionalProperties: false,
        },
      ],
    };

    const codexSchema = compileSchemaForCodex(schema);
    const openaiSchema = compileSchemaForOpenAI({
      oneOf: [
        {
          type: 'object',
          properties: { action: { const: 'done', type: 'string' } },
          required: ['action'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { action: { const: 'continue', type: 'string' } },
          required: ['action'],
          additionalProperties: false,
        },
      ],
    });

    expect(JSON.stringify(codexSchema)).not.toContain('"anyOf"');
    expect(JSON.stringify(codexSchema)).not.toContain('"oneOf"');
    expect(codexSchema.type).toBe('object');
    expect((codexSchema.properties as Record<string, unknown>)?.result).toBeUndefined();

    expect(JSON.stringify(openaiSchema)).not.toContain('"oneOf"');
    expect(JSON.stringify(openaiSchema)).toContain('"anyOf"');
    expect(openaiSchema.type).toBe('object');
    expect((openaiSchema.properties as Record<string, unknown>)?.result).toBeDefined();
  });

  it('merges object unions into enum-compatible object schemas for codex', () => {
    const codexSchema = compileSchemaForCodex({
      anyOf: [
        {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'done' },
            goalStateReached: { type: 'boolean', const: true },
            work_done: { type: 'string' },
          },
          required: ['action', 'goalStateReached', 'work_done'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            action: { type: 'string', const: 'continue' },
            goalStateReached: { type: 'boolean', const: false },
            work_done: { type: 'string' },
          },
          required: ['action', 'goalStateReached', 'work_done'],
          additionalProperties: false,
        },
      ],
    });

    expect(codexSchema.type).toBe('object');
    expect(JSON.stringify(codexSchema)).not.toContain('"anyOf"');
    expect(JSON.stringify(codexSchema)).not.toContain('"oneOf"');
    const actionSchema = (((codexSchema.properties as Record<string, unknown>)?.action ?? null) as Record<string, unknown> | null);
    expect(actionSchema?.enum).toEqual(['done', 'continue']);
  });

  it('does not rename schema property names that happen to match combinator keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        anyOf: { type: 'string' },
        oneOf: { type: 'string' },
      },
      required: ['anyOf', 'oneOf'],
      additionalProperties: false,
    };

    const codexSchema = compileSchemaForCodex(schema);
    const openaiSchema = compileSchemaForOpenAI(schema);
    const codexProperties = codexSchema.properties as Record<string, unknown>;
    const openaiProperties = openaiSchema.properties as Record<string, unknown>;

    expect(codexProperties.anyOf).toEqual({ type: 'string' });
    expect(codexProperties.oneOf).toEqual({ type: 'string' });
    expect(openaiProperties.anyOf).toEqual({ type: 'string' });
    expect(openaiProperties.oneOf).toEqual({ type: 'string' });
  });

  it('keeps concrete field types when collapsing goal_driven union for codex', () => {
    const canonical = getOutputSchemaJson('goal_driven');
    expect(canonical).toBeDefined();

    const compiled = compileSchemaForCodex(canonical!.schema, 'goal_driven');
    const properties = compiled.properties as Record<string, unknown>;

    expect((properties.action as Record<string, unknown>)?.type).toBe('string');
    expect((properties.response as Record<string, unknown>)?.type).toBe('string');
    expect((properties.goalStateReached as Record<string, unknown>)?.type).toBe('boolean');
    expect((properties.awaitingUserInput as Record<string, unknown>)?.type).toBe('boolean');
    expect((properties.work_done as Record<string, unknown>)?.type).toBe('string');

    const serialized = JSON.stringify(compiled);
    expect(serialized).not.toContain('"anyOf"');
    expect(serialized).not.toContain('"oneOf"');
  });

  it('preserves nullable field types when collapsing explorer union for codex', () => {
    const canonical = getOutputSchemaJson('explorer');
    expect(canonical).toBeDefined();

    const compiled = compileSchemaForCodex(canonical!.schema, 'explorer');
    const properties = compiled.properties as Record<string, unknown>;
    const artifacts = properties.artifacts as Record<string, unknown>;
    const artifactItems = artifacts.items as Record<string, unknown>;
    const artifactProps = artifactItems.properties as Record<string, unknown>;

    const lineSchema = artifactProps.line as Record<string, unknown>;
    const lineTypes = Array.isArray(lineSchema.type) ? lineSchema.type : [lineSchema.type];
    expect(lineTypes).toContain('integer');
    expect(lineTypes).toContain('null');

    const signatureSchema = artifactProps.signature as Record<string, unknown>;
    const signatureTypes = Array.isArray(signatureSchema.type) ? signatureSchema.type : [signatureSchema.type];
    expect(signatureTypes).toContain('string');
    expect(signatureTypes).toContain('null');
  });

  it('does not reuse schema-id cache entries for different schema objects', () => {
    const first = compileSchemaForCodex({
      type: 'object',
      properties: {
        first: { type: 'string' },
      },
      required: ['first'],
      additionalProperties: false,
    }, 'cache_collision_probe');

    const second = compileSchemaForCodex({
      type: 'object',
      properties: {
        second: { type: 'string' },
      },
      required: ['second'],
      additionalProperties: false,
    }, 'cache_collision_probe');

    const firstProperties = first.properties as Record<string, unknown>;
    const secondProperties = second.properties as Record<string, unknown>;

    expect(firstProperties.first).toBeDefined();
    expect(secondProperties.second).toBeDefined();
    expect(secondProperties.first).toBeUndefined();
  });
});
