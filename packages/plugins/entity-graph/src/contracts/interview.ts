/**
 * Domain Interview
 *
 * Guided questionnaire that seeds intent-derived contracts from a domain model.
 * The interview produces a DomainModel from 5 questions. Each hard rule becomes
 * an invariant contract, critical path items become guarantee contracts, and
 * pain points become assumption contracts tagged for review.
 */

import type { Contract, ContractType, DomainModel } from './types.js'

// --- Interview Types ---

export interface InterviewResponses {
  systemDescription: string
  entities: string
  criticalPath: string
  hardRules: string
  painPoints: string
}

export interface InterviewQuestion {
  id: keyof InterviewResponses
  prompt: string
  hint: string
}

export const INTERVIEW_QUESTIONS: InterviewQuestion[] = [
  {
    id: 'systemDescription',
    prompt: 'What does this system do?',
    hint: 'A brief description of what the system does and who it serves.',
  },
  {
    id: 'entities',
    prompt: 'What are the core domain entities?',
    hint: 'Comma-separated list of the key nouns/concepts (e.g., User, Order, Payment).',
  },
  {
    id: 'criticalPath',
    prompt: "What's the critical path that cannot break?",
    hint: 'The primary workflow — step by step (e.g., "User logs in, adds to cart, checks out, payment confirms").',
  },
  {
    id: 'hardRules',
    prompt: 'What are the hard rules — things that must never happen?',
    hint: 'One rule per line (e.g., "User balance never goes negative").',
  },
  {
    id: 'painPoints',
    prompt: 'Where do bugs actually show up?',
    hint: 'One pain point per line (e.g., "Webhook sometimes fires twice causing duplicates").',
  },
]

// --- Domain Model Construction ---

export function buildDomainModel(responses: InterviewResponses): DomainModel {
  const entities = responses.entities
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(name => ({ name, description: '', aliases: [] }))

  const hardRules = responses.hardRules
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)

  const painPoints = responses.painPoints
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)

  return {
    version: 1,
    systemDescription: responses.systemDescription.trim(),
    entities,
    criticalPath: responses.criticalPath.trim(),
    hardRules,
    painPoints,
  }
}

// --- Contract Seeding ---

export function seedContractsFromDomain(
  domain: DomainModel,
): Array<Omit<Contract, 'id' | 'createdAt' | 'updatedAt'>> {
  const contracts: Array<Omit<Contract, 'id' | 'createdAt' | 'updatedAt'>> = []

  const baseFields = {
    testFilePath: null,
    verificationPlanJson: null,
    verdictRule: null,
    refinedIntent: null,
    compileStatus: null as Contract['compileStatus'],
    lastVerdict: null as Contract['lastVerdict'],
    lastVerdictAt: null,
  }

  // Hard rules → invariant contracts
  for (const rule of domain.hardRules) {
    contracts.push({
      statement: rule,
      type: 'invariant',
      source: 'interview',
      status: 'insufficient',
      confidence: 1.0,
      domainId: null,
      ...baseFields,
    })
  }

  // Critical path steps → guarantee contracts
  if (domain.criticalPath) {
    const steps = domain.criticalPath
      .split(/[,;→]/)
      .map(s => s.trim())
      .filter(Boolean)

    for (const step of steps) {
      contracts.push({
        statement: `Critical path: ${step}`,
        type: 'guarantee',
        source: 'interview',
        status: 'insufficient',
        confidence: 0.8,
        domainId: null,
        ...baseFields,
      })
    }
  }

  // Pain points → assumption contracts tagged for review
  for (const point of domain.painPoints) {
    contracts.push({
      statement: `Known pain point: ${point}`,
      type: 'assumption',
      source: 'interview',
      status: 'insufficient',
      confidence: 0.7,
      domainId: null,
      ...baseFields,
    })
  }

  return contracts
}
