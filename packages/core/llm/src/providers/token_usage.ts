import type { TokenUsage } from 'types';

type UsageRecord = Record<string, unknown>;

interface NormalizeUsageOptions {
  promptTokenKey: string;
  completionTokenKey: string;
  totalTokenKey: string;
}

function asRecord(value: unknown): UsageRecord | undefined {
  return typeof value === 'object' && value !== null ? value as UsageRecord : undefined;
}

function asTokenCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function readRequiredToken(record: UsageRecord | undefined, key: string): number {
  return asTokenCount(record?.[key]) ?? 0;
}

function readOptionalToken(record: UsageRecord | undefined, key: string): number | undefined {
  return asTokenCount(record?.[key]);
}

function extractReasoningTokens(usage: UsageRecord | undefined): number | undefined {
  const completionDetails = asRecord(usage?.completion_tokens_details);
  const outputDetails = asRecord(usage?.output_tokens_details);

  return (
    asTokenCount(usage?.reasoning_tokens)
    ?? asTokenCount(usage?.reasoningTokens)
    ?? asTokenCount(completionDetails?.reasoning_tokens)
    ?? asTokenCount(completionDetails?.reasoningTokens)
    ?? asTokenCount(outputDetails?.reasoning_tokens)
    ?? asTokenCount(outputDetails?.reasoningTokens)
  );
}

function extractCachedPromptTokens(usage: UsageRecord | undefined): number | undefined {
  const promptDetails = asRecord(usage?.prompt_tokens_details);
  return (
    asTokenCount(promptDetails?.cached_tokens)
    ?? asTokenCount(promptDetails?.cachedTokens)
  );
}

function normalizeUsage(usageData: unknown, options: NormalizeUsageOptions): TokenUsage {
  const usage = asRecord(usageData);
  if (!usage) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  const promptTokens = readRequiredToken(usage, options.promptTokenKey);
  const completionTokens = readRequiredToken(usage, options.completionTokenKey);
  const reasoningTokens = extractReasoningTokens(usage);
  const rawTotalTokens = readOptionalToken(usage, options.totalTokenKey);
  const totalTokens = rawTotalTokens !== undefined ? rawTotalTokens : promptTokens + completionTokens;

  const cachedTokens = extractCachedPromptTokens(usage);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    reasoningTokens,
  };
}

export function normalizeResponsesApiUsage(usageData: unknown): TokenUsage {
  return normalizeUsage(usageData, {
    promptTokenKey: 'input_tokens',
    completionTokenKey: 'output_tokens',
    totalTokenKey: 'total_tokens',
  });
}

export function normalizeChatCompletionsUsage(usageData: unknown): TokenUsage {
  return normalizeUsage(usageData, {
    promptTokenKey: 'prompt_tokens',
    completionTokenKey: 'completion_tokens',
    totalTokenKey: 'total_tokens',
  });
}
