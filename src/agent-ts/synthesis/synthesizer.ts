/**
 * Response Synthesis Module.
 *
 * Handles synthesizing final responses from execution results and streaming them.
 * Used by both Wizard and Executor for consistent response generation.
 *
 * Ported from: src/harness/agent/synthesis.py
 */

import type { LLMAdapter } from '../llm/index.js';
import type { WizardEvent } from '../types/events.js';

/**
 * Streaming callback protocol.
 */
export type StreamCallback = (chunk: string, chunkIndex: number, isFinal: boolean) => void;

/**
 * Input data for response synthesis.
 */
export interface SynthesisInput {
  goal: string;
  goalType: string; // "task" | "question"
  toolOutputs: Array<{ tool: string; output: string }>;
  stepSummaries: string[];
  userIntent?: string;
  successCriteria?: string;
  partialResponse?: string;
}

/**
 * Create synthesis input from tool outputs.
 */
export function createSynthesisInput(
  goal: string,
  toolOutputs: Array<{ tool: string; output: string }> = [],
  goalType = 'task'
): SynthesisInput {
  return {
    goal,
    goalType,
    toolOutputs,
    stepSummaries: [],
  };
}

/**
 * Result of response synthesis.
 */
export interface SynthesisResult {
  content: string;
  durationMs: number;
  streamed: boolean;
  llmCalled: boolean;
  toolCount: number;
  synthesisMethod: 'direct' | 'llm' | 'fallback';
}

// Synthesis prompt templates
const SYNTHESIS_PROMPT_TEMPLATE = `Based on the execution results below, provide a clear, concise answer to the user's request.

User's request: {goal}

{results_section}

Instructions:
- Provide a natural, conversational response that directly answers the user's question
- Do not repeat raw data - summarize and explain the key findings
- Be concise but complete
- If the goal was a task (not a question), confirm what was done
`;

const QUESTION_SYNTHESIS_TEMPLATE = `Based on the information gathered, answer this question:

Question: {goal}

{results_section}

Provide a direct, informative answer. Be concise but complete.
`;

/**
 * Synthesizes final responses from execution results.
 */
export class ResponseSynthesizer {
  private llm?: LLMAdapter;
  private maxToolOutputs: number;
  private maxOutputPreview: number;
  private eventEmitter?: (event: WizardEvent) => void;

  constructor(
    llm?: LLMAdapter,
    maxToolOutputs = 5,
    maxOutputPreview = 1000,
    eventEmitter?: (event: WizardEvent) => void
  ) {
    this.llm = llm;
    this.maxToolOutputs = maxToolOutputs;
    this.maxOutputPreview = maxOutputPreview;
    this.eventEmitter = eventEmitter;
  }

  /**
   * Synthesize a final response from execution results.
   */
  async synthesize(
    input: SynthesisInput,
    onStream?: StreamCallback,
    forceLlm = false
  ): Promise<SynthesisResult> {
    const startTime = Date.now();

    // Strategy 1: Use partial response if available and good quality
    if (!forceLlm && input.partialResponse) {
      const content = input.partialResponse;
      if (this.isQualityResponse(content, input)) {
        if (onStream) {
          this.streamContent(content, onStream);
        }
        return {
          content,
          durationMs: Date.now() - startTime,
          streamed: !!onStream,
          llmCalled: false,
          toolCount: input.toolOutputs.length,
          synthesisMethod: 'direct',
        };
      }
    }

    // Strategy 2: Use LLM for intelligent synthesis
    if (this.llm && (forceLlm || input.toolOutputs.length > 0)) {
      try {
        const content = await this.synthesizeWithLlm(input, onStream);
        return {
          content,
          durationMs: Date.now() - startTime,
          streamed: !!onStream,
          llmCalled: true,
          toolCount: input.toolOutputs.length,
          synthesisMethod: 'llm',
        };
      } catch {
        // Fall through to fallback
      }
    }

    // Strategy 3: Fallback - concatenate available data
    const content = this.fallbackSynthesis(input);
    if (onStream) {
      this.streamContent(content, onStream);
    }

    return {
      content,
      durationMs: Date.now() - startTime,
      streamed: !!onStream,
      llmCalled: false,
      toolCount: input.toolOutputs.length,
      synthesisMethod: 'fallback',
    };
  }

  /**
   * Stream existing content through callback.
   */
  streamContent(content: string, callback: StreamCallback, chunkSize = 50): void {
    let chunkIndex = 0;
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, i + chunkSize);
      const isFinal = i + chunkSize >= content.length;
      callback(chunk, chunkIndex, isFinal);
      chunkIndex++;
    }

    // Ensure final signal sent
    if (content && chunkIndex > 0) {
      callback('', chunkIndex, true);
    }
  }

  /**
   * Check if partial response is good enough to use directly.
   */
  private isQualityResponse(content: string, input: SynthesisInput): boolean {
    if (!content || content.length < 20) return false;

    // Check for raw output markers
    const rawMarkers = ['```', 'Error:', '[stderr]', 'Traceback'];
    if (rawMarkers.some((marker) => content.slice(0, 100).includes(marker))) {
      return false;
    }

    // For questions, response should be substantive
    if (input.goalType === 'question' && content.length < 50) {
      return false;
    }

    return true;
  }

  /**
   * Use LLM to synthesize response.
   */
  private async synthesizeWithLlm(
    input: SynthesisInput,
    onStream?: StreamCallback
  ): Promise<string> {
    if (!this.llm) {
      throw new Error('No LLM available for synthesis');
    }

    // Build results section
    const resultsParts: string[] = [];

    for (const output of input.toolOutputs.slice(0, this.maxToolOutputs)) {
      const toolOutput = output.output.slice(0, this.maxOutputPreview);
      resultsParts.push(`- ${output.tool}: ${toolOutput}`);
    }

    if (input.stepSummaries.length > 0) {
      resultsParts.push('\nStep summaries:');
      for (const summary of input.stepSummaries.slice(0, 3)) {
        resultsParts.push(`- ${summary}`);
      }
    }

    const resultsSection =
      resultsParts.length > 0 ? resultsParts.join('\n') : 'No tool outputs collected.';

    // Choose prompt template based on goal type
    let prompt: string;
    if (input.goalType === 'question') {
      prompt = QUESTION_SYNTHESIS_TEMPLATE.replace('{goal}', input.goal).replace(
        '{results_section}',
        resultsSection
      );
    } else {
      prompt = SYNTHESIS_PROMPT_TEMPLATE.replace('{goal}', input.goal).replace(
        '{results_section}',
        `Tool results:\n${resultsSection}`
      );
    }

    // Call LLM
    const response = await this.llm.respond({
      messages: [{ role: 'user', content: prompt }] as any,
    });
    const content = response.content ?? '';

    if (onStream) {
      this.streamContent(content, onStream);
    }

    return content;
  }

  /**
   * Generate fallback response when LLM unavailable.
   */
  private fallbackSynthesis(input: SynthesisInput): string {
    // Use partial response if available
    if (input.partialResponse) {
      return input.partialResponse;
    }

    const parts: string[] = [];

    // Build from tool outputs
    if (input.toolOutputs.length > 0) {
      parts.push(`Results for: ${input.goal}`);
      for (const output of input.toolOutputs.slice(0, 3)) {
        const toolOutput = output.output.slice(0, 500);
        parts.push(`\n${output.tool}:\n${toolOutput}`);
      }
    } else if (input.stepSummaries.length > 0) {
      parts.push(`Completed: ${input.goal}`);
      for (const summary of input.stepSummaries.slice(0, 3)) {
        parts.push(`- ${summary}`);
      }
    } else {
      parts.push(`Task processing complete: ${input.goal}`);
    }

    return parts.join('\n');
  }
}

/**
 * Convenience function for one-shot synthesis.
 */
export async function synthesizeResponse(
  goal: string,
  toolOutputs: Array<{ tool: string; output: string }>,
  llm?: LLMAdapter,
  onStream?: StreamCallback,
  goalType = 'task'
): Promise<SynthesisResult> {
  const synthesizer = new ResponseSynthesizer(llm);
  const input = createSynthesisInput(goal, toolOutputs, goalType);
  return synthesizer.synthesize(input, onStream);
}

/**
 * Convenience function to stream text through a callback.
 */
export function streamText(
  content: string,
  callback: StreamCallback,
  chunkSize = 50
): void {
  const synthesizer = new ResponseSynthesizer();
  synthesizer.streamContent(content, callback, chunkSize);
}
