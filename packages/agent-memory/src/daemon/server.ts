/**
 * HTTP Server
 *
 * Lightweight HTTP server for the Sync Daemon API.
 * Built on Node.js native http module with minimal dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import type { Socket } from 'net'

// ============ Types ============

export interface ServerConfig {
  /** Port to listen on */
  port: number
  /** Host to bind to (default: '0.0.0.0') */
  host?: string
  /** Base path for API routes (default: '/api') */
  basePath?: string
}

export interface ParsedRequest {
  /** HTTP method */
  method: string
  /** Request path (without query string) */
  path: string
  /** URL parameters (e.g., :id -> id) */
  params: Record<string, string>
  /** Query string parameters */
  query: Record<string, string>
  /** Parsed JSON body */
  body: unknown
  /** Request headers (lowercase keys) */
  headers: Record<string, string>
  /** Raw request object */
  raw: IncomingMessage
}

export interface RouteResponse {
  /** HTTP status code (default: 200) */
  status?: number
  /** Response body (will be JSON serialized) */
  body?: unknown
  /** Raw body string (bypasses JSON serialization, e.g., for HTML) */
  rawBody?: string
  /** Additional headers */
  headers?: Record<string, string>
}

export type RouteHandler = (req: ParsedRequest) => Promise<RouteResponse>

interface Route {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: RouteHandler
}

// ============ HTTP Server ============

/**
 * Lightweight HTTP server with routing.
 *
 * Features:
 * - Path parameter support (e.g., /users/:id)
 * - JSON request/response
 * - Query string parsing
 * - Graceful shutdown
 * - Error handling
 *
 * @example
 * ```ts
 * const server = new HttpServer({ port: 3000 })
 *
 * server.get('/health', async () => ({ body: { status: 'ok' } }))
 * server.get('/users/:id', async (req) => ({ body: { id: req.params.id } }))
 * server.post('/users', async (req) => ({ status: 201, body: req.body }))
 *
 * await server.start()
 * ```
 */
export class HttpServer {
  private server: Server | null = null
  private routes: Route[] = []
  private connections = new Set<Socket>()
  private config: Required<ServerConfig>

  constructor(config: ServerConfig) {
    this.config = {
      host: '0.0.0.0',
      basePath: '/api',
      ...config,
    }
  }

  // ============ Route Registration ============

  /**
   * Register a GET route.
   */
  get(path: string, handler: RouteHandler): this {
    return this.addRoute('GET', path, handler)
  }

  /**
   * Register a POST route.
   */
  post(path: string, handler: RouteHandler): this {
    return this.addRoute('POST', path, handler)
  }

  /**
   * Register a PUT route.
   */
  put(path: string, handler: RouteHandler): this {
    return this.addRoute('PUT', path, handler)
  }

  /**
   * Register a DELETE route.
   */
  delete(path: string, handler: RouteHandler): this {
    return this.addRoute('DELETE', path, handler)
  }

  /**
   * Register a PATCH route.
   */
  patch(path: string, handler: RouteHandler): this {
    return this.addRoute('PATCH', path, handler)
  }

  /**
   * Register a route at an absolute path (bypasses basePath).
   * Use for webhooks and other non-API endpoints.
   */
  raw(method: string, path: string, handler: RouteHandler): this {
    return this.addRouteRaw(method.toUpperCase(), path, handler)
  }

  // ============ Lifecycle ============

  /**
   * Start the HTTP server.
   */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Server is already running')
    }

    // Add built-in health check
    this.get('/health', async () => ({
      body: { status: 'ok', timestamp: new Date().toISOString() },
    }))

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res))

      // Track connections for graceful shutdown
      this.server.on('connection', (socket) => {
        this.connections.add(socket)
        socket.on('close', () => this.connections.delete(socket))
      })

      this.server.on('error', reject)

      this.server.listen(this.config.port, this.config.host, () => {
        resolve()
      })
    })
  }

  /**
   * Stop the HTTP server gracefully.
   */
  async stop(): Promise<void> {
    if (!this.server) return

    return new Promise((resolve) => {
      // Stop accepting new connections
      this.server!.close(() => {
        this.server = null
        resolve()
      })

      // Close existing connections
      for (const socket of this.connections) {
        socket.destroy()
      }
      this.connections.clear()
    })
  }

  /**
   * Check if the server is running.
   */
  get running(): boolean {
    return this.server !== null
  }

  /**
   * Get the port the server is listening on.
   */
  get port(): number {
    return this.config.port
  }

  // ============ Internal ============

  private addRoute(method: string, path: string, handler: RouteHandler): this {
    // Build full path with base path
    const fullPath = this.config.basePath + path
    return this.addRouteRaw(method, fullPath, handler)
  }

  private addRouteRaw(method: string, path: string, handler: RouteHandler): this {
    // Extract parameter names and build regex pattern
    const paramNames: string[] = []
    const pattern = path
      .replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, (match) => {
        paramNames.push(match.slice(1))
        return '([^/]+)'
      })
      .replace(/\//g, '\\/')

    this.routes.push({
      method,
      pattern: new RegExp(`^${pattern}$`),
      paramNames,
      handler,
    })

    return this
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Parse URL
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      const path = url.pathname
      const method = req.method?.toUpperCase() || 'GET'

      // Find matching route
      let matchedRoute: Route | null = null
      let params: Record<string, string> = {}

      for (const route of this.routes) {
        if (route.method !== method) continue

        const match = path.match(route.pattern)
        if (match) {
          matchedRoute = route
          params = route.paramNames.reduce(
            (acc, name, i) => {
              acc[name] = decodeURIComponent(match[i + 1])
              return acc
            },
            {} as Record<string, string>
          )
          break
        }
      }

      if (!matchedRoute) {
        this.sendJson(res, 404, { error: 'Not Found', path })
        return
      }

      // Parse query string
      const query: Record<string, string> = {}
      url.searchParams.forEach((value, key) => {
        query[key] = value
      })

      // Parse body
      let body: unknown = null
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        body = await this.parseBody(req)
      }

      // Build parsed request
      const parsed: ParsedRequest = {
        method,
        path,
        params,
        query,
        body,
        headers: this.normalizeHeaders(req.headers),
        raw: req,
      }

      // Call handler
      const response = await matchedRoute.handler(parsed)

      // Send response
      if (response.rawBody !== undefined) {
        // Send raw body (e.g., HTML)
        this.sendRaw(res, response.status || 200, response.rawBody, response.headers)
      } else {
        // Send JSON
        this.sendJson(res, response.status || 200, response.body, response.headers)
      }
    } catch (error) {
      console.error('[HttpServer] Request error:', error)

      if (error instanceof HttpError) {
        this.sendJson(res, error.status, { error: error.message, code: error.code })
      } else {
        this.sendJson(res, 500, {
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }
  }

  private async parseBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let totalLength = 0
    const maxBodySize = 1024 * 1024 // 1MB

    return new Promise((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        totalLength += chunk.length
        if (totalLength > maxBodySize) {
          reject(new HttpError(413, 'Payload Too Large', 'PAYLOAD_TOO_LARGE'))
          return
        }
        chunks.push(chunk)
      })

      req.on('end', () => {
        if (chunks.length === 0) {
          resolve(null)
          return
        }

        const body = Buffer.concat(chunks).toString('utf-8')

        // Try to parse as JSON
        const contentType = req.headers['content-type'] || ''
        if (contentType.includes('application/json') || body.startsWith('{') || body.startsWith('[')) {
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new HttpError(400, 'Invalid JSON', 'INVALID_JSON'))
          }
        } else {
          resolve(body)
        }
      })

      req.on('error', reject)
    })
  }

  private normalizeHeaders(headers: IncomingMessage['headers']): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result[key.toLowerCase()] = value
      } else if (Array.isArray(value)) {
        result[key.toLowerCase()] = value.join(', ')
      }
    }
    return result
  }

  private sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers?: Record<string, string>
  ): void {
    const json = JSON.stringify(body ?? null)

    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
      ...headers,
    })
    res.end(json)
  }

  private sendRaw(
    res: ServerResponse,
    status: number,
    body: string,
    headers?: Record<string, string>
  ): void {
    res.writeHead(status, {
      'Content-Type': 'text/html',
      'Content-Length': Buffer.byteLength(body),
      ...headers,
    })
    res.end(body)
  }
}

// ============ HTTP Error ============

/**
 * HTTP error with status code.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * Create a 400 Bad Request error.
 */
export function badRequest(message: string, code = 'BAD_REQUEST'): HttpError {
  return new HttpError(400, message, code)
}

/**
 * Create a 401 Unauthorized error.
 */
export function unauthorized(message = 'Unauthorized', code = 'UNAUTHORIZED'): HttpError {
  return new HttpError(401, message, code)
}

/**
 * Create a 404 Not Found error.
 */
export function notFound(message = 'Not Found', code = 'NOT_FOUND'): HttpError {
  return new HttpError(404, message, code)
}

/**
 * Create a 409 Conflict error.
 */
export function conflict(message: string, code = 'CONFLICT'): HttpError {
  return new HttpError(409, message, code)
}

/**
 * Create a 500 Internal Server Error.
 */
export function internalError(message = 'Internal Server Error', code = 'INTERNAL_ERROR'): HttpError {
  return new HttpError(500, message, code)
}
