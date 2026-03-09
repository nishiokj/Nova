/**
 * Shared LLM configuration utilities.
 *
 * Consolidates the merge logic for building LLMRequestConfig from:
 * - ModelSelection (provider/model/reasoning from SessionStore)
 * - LLMParams (maxTokens/temperature from AgentConfig)
 */

import type { LLMRequestConfig, LLMProvider } from 'types';
import { getCanonicalProvider, getProviderBaseUrl } from 'types';

/**
 * Model selection from SessionStore - identifies WHICH model to use.
 * This is the shape expected by buildLLMRequestConfig.
 */
export interface ModelSelectionInput {
  provider: string;
  model: string;
  reasoning?: string;
  contextWindow: number;
}

/**
 * LLM operational parameters from AgentConfig - controls HOW the model runs.
 * This is the shape expected by buildLLMRequestConfig.
 */
export interface LLMParamsInput {
  maxTokens: number;
  temperature: number;
}

/**
 * Build a complete LLMRequestConfig from model selection + operational params.
 *
 * This is the SINGLE source of truth for merging model selection (from SessionStore)
 * with operational params (from AgentConfig). All call sites should use this function.
 *
 * @param modelSelection - Provider/model/reasoning from SessionStore
 * @param llmParams - Operational params (maxTokens, temperature) from AgentConfig
 * @returns Complete LLMRequestConfig ready for LLM adapter
 */
export function buildLLMRequestConfig(
  modelSelection: ModelSelectionInput,
  llmParams: LLMParamsInput
): LLMRequestConfig {
  const canonicalProvider: LLMProvider = getCanonicalProvider(modelSelection.provider);
  const baseUrl = getProviderBaseUrl(modelSelection.provider);
  const contextWindow = Math.trunc(modelSelection.contextWindow);

  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error(`Context window missing for model '${modelSelection.model}'`);
  }

  return {
    provider: canonicalProvider,
    model: modelSelection.model,
    maxTokens: llmParams.maxTokens,
    contextWindow,
    temperature: llmParams.temperature,
    displayProvider: modelSelection.provider,
    ...(baseUrl ? { baseUrl } : {}),
    ...(modelSelection.reasoning
      ? { reasoning: { effort: modelSelection.reasoning as 'low' | 'medium' | 'high' } }
      : {}),
  };
}
