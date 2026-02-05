/**
 * Local session storage utilities.
 *
 * Stores session token in ~/.config/harness/session.json for persistent login.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const CONFIG_DIR = join(homedir(), '.config', 'harness');
const SESSION_FILE = join(CONFIG_DIR, 'session.json');

/**
 * Stored session data.
 */
export interface LocalSession {
  sessionToken: string;
  userId: string;
  email: string;
  name?: string;
  createdAt: number;
}

/**
 * Load the local session if it exists.
 */
export function loadLocalSession(): LocalSession | null {
  try {
    if (!existsSync(SESSION_FILE)) {
      return null;
    }

    const data = readFileSync(SESSION_FILE, 'utf-8');
    return JSON.parse(data) as LocalSession;
  } catch {
    // Silently return null - do NOT use console.error as it breaks Ink rendering
    return null;
  }
}

/**
 * Save a session to local storage.
 */
export function saveLocalSession(session: LocalSession): void {
  // Ensure config directory exists
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  // Write session file with restricted permissions
  // Throws on failure - caller should handle
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
}

/**
 * Clear the local session (logout).
 */
export function clearLocalSession(): void {
  try {
    if (existsSync(SESSION_FILE)) {
      unlinkSync(SESSION_FILE);
    }
  } catch {
    // Silently ignore - do NOT use console.error as it breaks Ink rendering
  }
}

/**
 * Check if a local session exists.
 */
export function hasLocalSession(): boolean {
  return existsSync(SESSION_FILE);
}

/**
 * Get the session file path (for debugging).
 */
export function getSessionFilePath(): string {
  return SESSION_FILE;
}
