import type { Logger } from '../packages/agent-core/src/shared/logger.js';
import type { GraphStore, SiasDecisionRecord } from '../packages/graphd/src/index.js';

interface FlipFlopResult {
  is_flip_flop: boolean;
  similar_decisions: Array<{ decision: SiasDecisionRecord; similarity: number }>;
  recommendation: string;
}

export class FlipFlopDetector {
  private similarityThreshold: number;
  private minIterationGap: number;

  constructor(
    private readonly store: GraphStore,
    private readonly logger: Logger,
    similarityThreshold = 0.85,
    minIterationGap = 5
  ) {
    this.similarityThreshold = similarityThreshold;
    this.minIterationGap = minIterationGap;
  }

  async checkForFlipFlop(newDecision: string, recentDecisions: SiasDecisionRecord[]): Promise<FlipFlopResult> {
    const newEmbedding = embedText(newDecision);
    const similar: Array<{ decision: SiasDecisionRecord; similarity: number }> = [];

    for (const past of recentDecisions) {
      const embeddingRecord = this.store.getSiasDecisionEmbedding(past.decisionId);
      if (!embeddingRecord?.embedding) {
        continue;
      }
      const similarity = cosineSimilarity(newEmbedding, embeddingRecord.embedding);
      if (similarity >= this.similarityThreshold) {
        similar.push({ decision: past, similarity });
      }
    }

    const isFlipFlop = similar.some((s) => {
      const iterationGap = Math.abs((s.decision.iteration ?? 0) - (recentDecisions.at(-1)?.iteration ?? 0));
      return iterationGap < this.minIterationGap;
    });

    const recommendation = isFlipFlop
      ? 'Similar decision detected recently; justify changes before reversing.'
      : 'No flip-flop risk detected.';

    if (isFlipFlop) {
      this.logger.warn('Flip-flop detected', {
        similar_decisions: similar.map((entry) => ({
          decision_id: entry.decision.decisionId,
          similarity: entry.similarity,
        })),
      });
    }

    return {
      is_flip_flop: isFlipFlop,
      similar_decisions: similar,
      recommendation,
    };
  }

  storeEmbedding(decisionId: string, decisionText: string): void {
    const embedding = embedText(decisionText);
    this.store.upsertSiasDecisionEmbedding(decisionId, embedding);
  }
}

function embedText(text: string, dimensions = 128): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);

  for (const token of tokens) {
    const hash = hashToken(token);
    const index = hash % dimensions;
    vector[index] += 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0)) || 1;
  return vector.map((val) => val / norm);
}

function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i += 1) {
    hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB) || 1;
  return dot / denom;
}
