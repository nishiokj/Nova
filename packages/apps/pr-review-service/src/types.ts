export interface PRReviewJob {
  installationId: number | null
  repoFullName: string
  cloneUrl: string
  prNumber: number
  action: string
  baseSha: string
  headSha: string
}

export interface ServiceConfig {
  port: number
  webhookSecret?: string
  apiBase: string
  staticGithubToken?: string
  githubAppId?: string
  githubAppPrivateKey?: string
  entityGraphDatabaseUrl: string
  workspaceParentDir: string
  prReviewScriptPath: string
  bunBin: string
  gitBin: string
  requestTimeoutMs: number
}

export interface JobRunResult {
  markdownPath: string
  jsonPath: string
  summary?: string
}
