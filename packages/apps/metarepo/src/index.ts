import { createServer, type Server } from 'node:http'
import { createRequestListener } from './analysis_routes.js'
import { loadConfigFromEnv } from './config.js'
import { DatabaseManager } from './database_manager.js'
import type { MetarepoApi, ServiceConfig } from './types.js'
import { MetarepoService } from './service.js'

export function createMetarepoApi(config: ServiceConfig): MetarepoApi {
  const databaseManager = new DatabaseManager(config.databaseUrl)
  return new MetarepoService(config, databaseManager)
}

export function createMetarepoServer(
  config: ServiceConfig,
  api: MetarepoApi = createMetarepoApi(config),
): Server {
  return createServer(createRequestListener(api))
}

export async function main(): Promise<void> {
  const config = loadConfigFromEnv()
  const server = createMetarepoServer(config)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      console.log(`[metarepo] Listening on ${config.host}:${config.port}`)
      resolve()
    })
  })
}

if (import.meta.main) {
  main().catch(error => {
    console.error('[metarepo] Fatal startup error:', error)
    process.exit(1)
  })
}
