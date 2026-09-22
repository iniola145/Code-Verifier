import * as fs from 'fs';
import * as path from 'path';
import { DiagnosticSeverity } from './types/verifier';

// =========================================================================
// Per-project config: .codeverifier.json (searched upward from the target)
// =========================================================================

export interface VerifierConfig {
  exclude: string[];
  disable: string[];
  severities: Record<string, DiagnosticSeverity>;
  baseline?: string;
  failOn: DiagnosticSeverity;
}

const DEFAULT_CONFIG: VerifierConfig = { exclude: [], disable: [], severities: {}, failOn: 'MEDIUM' };
const VALID_SEVERITIES = new Set<DiagnosticSeverity>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
const CONFIG_KEYS = new Set(['exclude', 'disable', 'severities', 'baseline', 'failOn']);

function validateStringArray(raw: unknown, key: string, errors: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string')) {
    errors.push(`"${key}" must be an array of strings.`);
    return [];
  }
  return raw;
}

function validateSeverities(raw: unknown, errors: string[]): Record<string, DiagnosticSeverity> {
  const out: Record<string, DiagnosticSeverity> = {};
  if (raw === undefined) return out;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('"severities" must be an object mapping rule ids to severities.');
    return out;
  }
  for (const [ruleId, sev] of Object.entries(raw)) {
    if (VALID_SEVERITIES.has(sev as DiagnosticSeverity)) out[ruleId] = sev as DiagnosticSeverity;
    else errors.push(`"severities.${ruleId}" must be CRITICAL, HIGH, MEDIUM, LOW, or INFO.`);
  }
  return out;
}

/**
 * Finds the nearest .codeverifier.json, walking up from `startDir` to the
 * filesystem root. Returns the default config when none exists.
 */
export function loadConfig(startDir: string): { config: VerifierConfig; configPath: string | null; errors: string[] } {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, '.codeverifier.json');
    if (fs.existsSync(candidate)) {
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          return { config: DEFAULT_CONFIG, configPath: candidate, errors: ['Configuration root must be an object.'] };
        }
        const value = raw as Record<string, unknown>;
        const errors: string[] = [];
        for (const key of Object.keys(value)) {
          if (!CONFIG_KEYS.has(key)) errors.push(`Unknown configuration key "${key}".`);
        }
        const failOn = value.failOn === undefined ? 'MEDIUM' : value.failOn;
        if (!VALID_SEVERITIES.has(failOn as DiagnosticSeverity)) {
          errors.push('"failOn" must be CRITICAL, HIGH, MEDIUM, LOW, or INFO.');
        }
        if (value.baseline !== undefined && typeof value.baseline !== 'string') {
          errors.push('"baseline" must be a file path string.');
        }
        return {
          config: {
            exclude: validateStringArray(value.exclude, 'exclude', errors),
            disable: validateStringArray(value.disable, 'disable', errors),
            severities: validateSeverities(value.severities, errors),
            baseline: typeof value.baseline === 'string' ? value.baseline : undefined,
            failOn: VALID_SEVERITIES.has(failOn as DiagnosticSeverity) ? failOn as DiagnosticSeverity : 'MEDIUM',
          },
          configPath: candidate,
          errors,
        };
      } catch (error: any) {
        return { config: DEFAULT_CONFIG, configPath: candidate, errors: [`Could not parse configuration: ${error.message}`] };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { config: DEFAULT_CONFIG, configPath: null, errors: [] };
    dir = parent;
  }
}

/**
 * Simple glob -> RegExp: a globstar crosses directories, `*` stays within
 * one segment, `?` is one char. A leading globstar-slash also matches at
 * the root.
 */
export function globToRegExp(pattern: string): RegExp {
  const leadingGlobstar = pattern.startsWith('**/');
  const core = leadingGlobstar ? pattern.slice(3) : pattern;
  let re = '';
  for (let i = 0; i < core.length; i++) {
    const ch = core[i];
    if (core.startsWith('**', i)) {
      re += '.*';
      i++;
    } else if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\^$.+?()[]{}|/'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  const body = leadingGlobstar ? `(?:.*/)?${re}` : re;
  return new RegExp(`^${body}$`);
}

/** True when a path matches any exclude glob (also tried on the basename). */
export function isExcluded(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.split(path.sep).join('/');
  for (const p of patterns) {
    try {
      const re = globToRegExp(p);
      if (re.test(normalized) || re.test(path.basename(normalized))) return true;
    } catch {
      return true; // broken pattern: exclude to be safe
    }
  }
  return false;
}
