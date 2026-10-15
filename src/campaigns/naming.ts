/**
 * Name used for a duplicated campaign.
 * Keeps the historical bot rule (`<tên gốc> - API`) and never adds Copy / COPIED_.
 */
export function buildDuplicateCampaignName(baseName: string): string {
  const normalizedBaseName = String(baseName || 'Campaign').trim() || 'Campaign';
  const apiSuffixPattern = /\s*-\s*API$/i;
  const baseWithoutSuffix = normalizedBaseName.replace(apiSuffixPattern, '').trim() || normalizedBaseName;
  return `${baseWithoutSuffix} - API`.slice(0, 512);
}

export function nameContainsCopyPrefix(name: string): boolean {
  return /^(copied_|copy[\s_-])/i.test(name.trim());
}
