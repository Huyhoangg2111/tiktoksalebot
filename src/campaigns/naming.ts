/**
 * Name used for a duplicated campaign.
 * Keeps the historical bot rule (`<tên gốc> - API`) and never adds Copy / COPIED_.
 */
const DUPLICATE_NAME_SUFFIX = ' - API';

export function buildDuplicateCampaignName(baseName: string): string {
  const normalizedBaseName = String(baseName || 'Campaign').trim() || 'Campaign';
  const apiSuffixPattern = /\s*-\s*API$/i;
  const baseWithoutSuffix = normalizedBaseName.replace(apiSuffixPattern, '').trim() || normalizedBaseName;
  const room = 512 - DUPLICATE_NAME_SUFFIX.length;
  return `${baseWithoutSuffix.slice(0, room).trimEnd()}${DUPLICATE_NAME_SUFFIX}`;
}

export function nameContainsCopyPrefix(name: string): boolean {
  return /^(copied_|copy[\s_-])/i.test(name.trim());
}
