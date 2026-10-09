import * as fs from "fs";
import * as path from "path";
import { Diagnostic } from "../types/verifier";
import { GeneratedTest } from "../test-gen/types";
import { TDRSession, TDRStatus, FixVerificationResult } from "./types";

export { TDRSession, TDRStatus, FixVerificationResult };

let customSessionDir: string | null = null;

/**
 * Configure a custom directory for TDR sessions (e.g. for testing).
 */
export function setSessionDir(dir: string | null): void {
  customSessionDir = dir;
}

/**
 * Get the active session directory path.
 */
export function getSessionDir(): string {
  if (customSessionDir) {
    return customSessionDir;
  }
  return path.join(process.cwd(), ".verifier", "sessions");
}

/**
 * Locate any existing unit test file for a given source file.
 */
export function findExistingTestFile(sourceFile: string): string | null {
  const dir = path.dirname(path.resolve(sourceFile));
  const ext = path.extname(sourceFile);
  const base = path.basename(sourceFile, ext);

  const candidateExtensions = [".tsx", ".ts", ".jsx", ".js"];
  const candidatePatterns: string[] = [];

  for (const cExt of candidateExtensions) {
    candidatePatterns.push(path.join(dir, `${base}.test${cExt}`));
    candidatePatterns.push(path.join(dir, `${base}.spec${cExt}`));
    candidatePatterns.push(path.join(dir, "__tests__", `${base}.test${cExt}`));
    candidatePatterns.push(path.join(dir, "__tests__", `${base}.spec${cExt}`));
  }

  for (const candidate of candidatePatterns) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Create a new TDR session. Automatically prunes expired sessions.
 */
export function createSession(
  sourceFile: string,
  findings: Diagnostic[],
  tests: GeneratedTest[],
  options?: { existingTestFound?: string },
): TDRSession {
  // Automatically prune old sessions to prevent disk bloat
  try {
    pruneSessions({ maxAgeDays: 7, maxSessions: 100 });
  } catch {
    // Ignore pruning errors
  }

  const id = `tdr-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const existingTestFound =
    options?.existingTestFound || findExistingTestFile(sourceFile) || undefined;

  const session: TDRSession = {
    id,
    createdAt: new Date().toISOString(),
    sourceFile: path.resolve(sourceFile),
    originalFindings: findings,
    generatedTests: tests,
    status: "tests_generated",
    existingTestFound,
  };
  saveSession(session);
  return session;
}

/**
 * Load a TDR session from disk.
 */
export function loadSession(sessionId: string): TDRSession | null {
  const sessionDir = getSessionDir();
  const filePath = path.join(sessionDir, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as TDRSession;
  } catch {
    return null;
  }
}

/**
 * Save a TDR session to disk.
 */
export function saveSession(session: TDRSession): void {
  const sessionDir = getSessionDir();
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  const filePath = path.join(sessionDir, `${session.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
}

/**
 * List all saved TDR sessions.
 */
export function listSessions(): TDRSession[] {
  const sessionDir = getSessionDir();
  if (!fs.existsSync(sessionDir)) {
    return [];
  }
  try {
    const files = fs.readdirSync(sessionDir);
    const sessions: TDRSession[] = [];
    for (const f of files) {
      if (f.endsWith(".json")) {
        const filePath = path.join(sessionDir, f);
        try {
          const raw = fs.readFileSync(filePath, "utf-8");
          sessions.push(JSON.parse(raw) as TDRSession);
        } catch {
          // ignore corrupted session file
        }
      }
    }
    // Return sessions sorted newest first
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

/**
 * Update an existing TDR session.
 */
export function updateSession(
  sessionId: string,
  updates: Partial<TDRSession>,
): TDRSession | null {
  const session = loadSession(sessionId);
  if (!session) {
    return null;
  }
  const updated: TDRSession = {
    ...session,
    ...updates,
    id: session.id, // Immutable ID
    createdAt: session.createdAt, // Immutable creation timestamp
  };
  saveSession(updated);
  return updated;
}

/**
 * Delete a TDR session from disk.
 */
export function deleteSession(sessionId: string): boolean {
  const sessionDir = getSessionDir();
  const filePath = path.join(sessionDir, `${sessionId}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * Prunes expired or excess sessions.
 * Default: retain sessions for 7 days and at most 100 sessions.
 */
export function pruneSessions(options?: {
  maxAgeDays?: number;
  maxSessions?: number;
}): number {
  const maxAgeDays = options?.maxAgeDays ?? 7;
  const maxSessions = options?.maxSessions ?? 100;
  const sessionDir = getSessionDir();
  if (!fs.existsSync(sessionDir)) return 0;

  let deletedCount = 0;
  const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const sessions = listSessions();

  // 1. Delete sessions older than maxAgeDays
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const created = new Date(s.createdAt).getTime();
    if (created < cutoffTime) {
      if (deleteSession(s.id)) deletedCount++;
    }
  }

  // 2. Bound total sessions to maxSessions (newest first)
  const remaining = listSessions();
  if (remaining.length > maxSessions) {
    const toDelete = remaining.slice(maxSessions);
    for (const s of toDelete) {
      if (deleteSession(s.id)) deletedCount++;
    }
  }

  return deletedCount;
}

/**
 * Clean all stored TDR sessions.
 */
export function cleanAllSessions(): number {
  const sessions = listSessions();
  let count = 0;
  for (const s of sessions) {
    if (deleteSession(s.id)) count++;
  }
  return count;
}
