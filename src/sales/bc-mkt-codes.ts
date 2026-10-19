/** Pure helpers for /bc (primary) and /bckhac (other) MKT resolution. */

const DEFAULT_PRIMARY_MKT_CODE = 'MKT80.HOÀNG-TH';

function normalizeKey(value: string): string {
  return value.trim().toLocaleUpperCase('vi-VN');
}

export function getPrimaryMktCode(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.TARGET_MKT_CODE?.trim() || DEFAULT_PRIMARY_MKT_CODE;
}

/** Explicit second MKT code from env (OTHER_MKT_CODE). */
export function getConfiguredOtherMktCode(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const value = env.OTHER_MKT_CODE?.trim();
  return value || undefined;
}

/**
 * Resolve MKT codes for the "khác" report:
 * 1. OTHER_MKT_CODE if set (single code)
 * 2. else every enabled dashboard MKT code that is not the primary
 */
export function resolveOtherMktCodes(options: {
  primaryMktCode: string;
  configuredOther?: string;
  dashboardCodes: string[];
}): string[] {
  const configured = options.configuredOther?.trim();
  if (configured) {
    return [configured];
  }

  const primaryKey = normalizeKey(options.primaryMktCode);
  return [...new Set(
    options.dashboardCodes
      .map(code => code.trim())
      .filter(code => code && normalizeKey(code) !== primaryKey)
  )].sort((a, b) => a.localeCompare(b, 'vi'));
}
