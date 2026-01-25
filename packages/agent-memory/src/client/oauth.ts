/**
 * OAuth Browser Flow Helper
 *
 * Captures OAuth callback via a local HTTP server.
 * Opens browser to authorization URL and waits for redirect.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import { URL } from 'url'

export interface OAuthResult {
  code: string
  state: string
}

export interface OAuthCallbackOptions {
  /** Local port to listen on (default: 9876) */
  port?: number
  /** Timeout in ms (default: 300000 = 5 min) */
  timeout?: number
  /** Whether to open browser automatically (default: true) */
  openBrowser?: boolean
}

const DEFAULT_PORT = 9876
const DEFAULT_TIMEOUT = 300000 // 5 minutes

/**
 * Opens browser for OAuth and captures callback via local server.
 *
 * @param authUrl - OAuth authorization URL from auth.getUrl()
 * @param options - Callback capture options
 * @returns Promise resolving to code and state from callback
 *
 * @example
 * ```ts
 * const { url, state } = await client.auth.getUrl('gmail', 'http://localhost:9876/callback')
 * const { code } = await captureOAuthCallback(url)
 * const account = await client.auth.callback('gmail', code, state, 'http://localhost:9876/callback')
 * ```
 */
export async function captureOAuthCallback(
  authUrl: string,
  options: OAuthCallbackOptions = {}
): Promise<OAuthResult> {
  const {
    port = DEFAULT_PORT,
    timeout = DEFAULT_TIMEOUT,
    openBrowser = true,
  } = options

  return new Promise((resolve, reject) => {
    let server: Server | null = null
    let timeoutId: NodeJS.Timeout | null = null

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      if (server) {
        server.close()
        server = null
      }
    }

    // Set timeout
    timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error(
        `OAuth callback timeout after ${timeout / 1000} seconds.\n` +
        `Please try again and complete authorization in your browser.`
      ))
    }, timeout)

    // Create callback server
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const requestUrl = new URL(req.url || '/', `http://localhost:${port}`)

      // Only handle /callback path
      if (requestUrl.pathname !== '/callback') {
        res.writeHead(404)
        res.end('Not Found')
        return
      }

      const code = requestUrl.searchParams.get('code')
      const state = requestUrl.searchParams.get('state')
      const error = requestUrl.searchParams.get('error')
      const errorDescription = requestUrl.searchParams.get('error_description')

      // Handle OAuth error
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Authorization Failed</title></head>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1>Authorization Failed</h1>
              <p style="color: #c00;">${errorDescription || error}</p>
              <p>You can close this window.</p>
            </body>
          </html>
        `)
        cleanup()
        reject(new Error(`OAuth error: ${errorDescription || error}`))
        return
      }

      // Validate callback parameters
      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Invalid Callback</title></head>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1>Invalid Callback</h1>
              <p style="color: #c00;">Missing code or state parameter.</p>
              <p>You can close this window.</p>
            </body>
          </html>
        `)
        cleanup()
        reject(new Error('Invalid OAuth callback: missing code or state'))
        return
      }

      // Success response
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>Authorization Successful</title></head>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1>Authorization Successful</h1>
            <p style="color: #090;">You can close this window and return to the terminal.</p>
            <script>setTimeout(() => window.close(), 2000)</script>
          </body>
        </html>
      `)

      cleanup()
      resolve({ code, state })
    })

    server.on('error', (err: Error & { code?: string }) => {
      cleanup()
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use.\n` +
          `Try a different port or close the application using it.`
        ))
      } else {
        reject(err)
      }
    })

    server.listen(port, '127.0.0.1', async () => {
      console.log(`OAuth callback server listening on http://localhost:${port}/callback`)

      if (openBrowser) {
        try {
          // Dynamic import for open package (ESM)
          const open = await import('open')
          await open.default(authUrl)
          console.log('Browser opened for authorization...')
        } catch (err) {
          console.log('\nCould not open browser automatically.')
          console.log('Please open this URL manually:\n')
          console.log(`  ${authUrl}\n`)
        }
      } else {
        console.log('\nOpen this URL in your browser:\n')
        console.log(`  ${authUrl}\n`)
      }
    })
  })
}

/**
 * Get the default redirect URI for OAuth callback.
 */
export function getCallbackUri(port = DEFAULT_PORT): string {
  return `http://localhost:${port}/callback`
}
