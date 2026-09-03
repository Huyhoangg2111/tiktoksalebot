/**
 * Session Store - Lưu/load session state (cookies, tokens) vào file
 * Tương thích với ads-session.ts hiện có
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ============================================================
// Types
// ============================================================

export interface SimpleCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None' | string;
  expires?: number;
}

export interface CapturedTokens {
  msToken?: string;
  xBogus?: string;
  xGnarly?: string;
  xCsrfToken?: string;
  ttTicketGuard?: string;
  [key: string]: string | undefined;
}

export interface PersistedSessionState {
  version: 2;
  savedAt: string;
  entryUrl: string;
  cookies: SimpleCookie[];
  tokens: CapturedTokens;
  cookieHeader: string;
  userAgent?: string;
}

// ============================================================
// Functions
// ============================================================

export function normalizeStatePath(filePath: string): string {
  return path.resolve(filePath);
}

export async function saveSessionState(
  filePath: string,
  payload: PersistedSessionState,
): Promise<{ path: string; cookieCount: number }> {
  const resolvedPath = normalizeStatePath(filePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, JSON.stringify(payload, null, 2), 'utf8');

  return {
    path: resolvedPath,
    cookieCount: payload.cookies.length,
  };
}

export async function loadSessionState(
  filePath: string,
): Promise<PersistedSessionState | null> {
  const resolvedPath = normalizeStatePath(filePath);

  try {
    const raw = await readFile(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedSessionState;

    if (!parsed || !Array.isArray(parsed.cookies)) {
      throw new Error('Session file khong hop le.');
    }

    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function removeSessionState(
  filePath: string,
): Promise<{ path: string }> {
  const resolvedPath = normalizeStatePath(filePath);
  await rm(resolvedPath, { force: true });

  return { path: resolvedPath };
}

/**
 * Build cookie header string from cookie array
 */
export function buildCookieHeader(cookies: SimpleCookie[]): string {
  return cookies
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Extract specific token cookies from cookie array
 */
export function extractTokensFromCookies(cookies: SimpleCookie[]): CapturedTokens {
  const tokens: CapturedTokens = {};

  for (const cookie of cookies) {
    const name = cookie.name.toLowerCase();

    if (name === 'mstoken') {
      tokens.msToken = cookie.value;
    } else if (name === 'csrftoken' || name === 'csrf_session_id' || name === 'tt_csrf_token') {
      tokens.xCsrfToken = cookie.value;
    } else if (name.startsWith('tt-ticket-')) {
      tokens.ttTicketGuard = cookie.value;
      tokens[cookie.name] = cookie.value;
    }
  }

  return tokens;
}
