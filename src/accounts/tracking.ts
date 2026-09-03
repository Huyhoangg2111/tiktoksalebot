import { db } from '../db/index.js';

export interface TrackableAdvertiser {
  advertiserId: string;
  advertiserName?: string;
}

export interface AdvertiserTrackingState extends TrackableAdvertiser {
  isTracked: boolean;
}

interface AdvertiserTrackingRow {
  advertiser_id: string;
  advertiser_name?: string;
  is_tracked: number;
}

function uniqueAdvertisers(accounts: TrackableAdvertiser[]): TrackableAdvertiser[] {
  const advertisers = new Map<string, TrackableAdvertiser>();

  accounts.forEach(account => {
    if (!account.advertiserId) {
      return;
    }

    const existingAccount = advertisers.get(account.advertiserId);
    if (!existingAccount || (!existingAccount.advertiserName && account.advertiserName)) {
      advertisers.set(account.advertiserId, account);
    }
  });

  return [...advertisers.values()];
}

export async function getAdvertiserTrackingStates(
  accounts: TrackableAdvertiser[]
): Promise<AdvertiserTrackingState[]> {
  const uniqueAccounts = uniqueAdvertisers(accounts);

  if (uniqueAccounts.length === 0) {
    return [];
  }

  for (const account of uniqueAccounts) {
    const existing = await db.get<AdvertiserTrackingRow>(
      'SELECT advertiser_id, advertiser_name, is_tracked FROM advertiser_tracking WHERE advertiser_id = ?',
      [account.advertiserId]
    );

    if (!existing) {
      await db.run(
        'INSERT INTO advertiser_tracking (advertiser_id, advertiser_name, is_tracked, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)',
        [account.advertiserId, account.advertiserName || null]
      );
      continue;
    }

    if (account.advertiserName && existing.advertiser_name !== account.advertiserName) {
      await db.run(
        'UPDATE advertiser_tracking SET advertiser_name = ?, updated_at = CURRENT_TIMESTAMP WHERE advertiser_id = ?',
        [account.advertiserName, account.advertiserId]
      );
    }
  }

  const placeholders = uniqueAccounts.map(() => '?').join(', ');
  const rows = await db.all<AdvertiserTrackingRow>(
    `SELECT advertiser_id, advertiser_name, is_tracked FROM advertiser_tracking WHERE advertiser_id IN (${placeholders})`,
    uniqueAccounts.map(account => account.advertiserId)
  );
  const trackingById = new Map(rows.map(row => [row.advertiser_id, row]));

  return uniqueAccounts.map(account => {
    const tracking = trackingById.get(account.advertiserId);

    return {
      advertiserId: account.advertiserId,
      advertiserName: account.advertiserName || tracking?.advertiser_name,
      isTracked: tracking ? Boolean(tracking.is_tracked) : true,
    };
  });
}

export async function getTrackedAdvertiserIdSet(accounts: TrackableAdvertiser[]): Promise<Set<string>> {
  const trackingStates = await getAdvertiserTrackingStates(accounts);
  return new Set(
    trackingStates
      .filter(account => account.isTracked)
      .map(account => account.advertiserId)
  );
}

export async function toggleAdvertiserTracking(
  advertiserId: string,
  advertiserName?: string
): Promise<AdvertiserTrackingState> {
  const [trackingState] = await getAdvertiserTrackingStates([
    {
      advertiserId,
      advertiserName,
    },
  ]);
  const isTracked = !trackingState.isTracked;

  await db.run(
    'UPDATE advertiser_tracking SET advertiser_name = ?, is_tracked = ?, updated_at = CURRENT_TIMESTAMP WHERE advertiser_id = ?',
    [advertiserName || trackingState.advertiserName || null, isTracked ? 1 : 0, advertiserId]
  );

  return {
    advertiserId,
    advertiserName: advertiserName || trackingState.advertiserName,
    isTracked,
  };
}

export async function syncAdvertiserTrackingCache(
  accounts: TrackableAdvertiser[]
): Promise<{
  states: AdvertiserTrackingState[];
  prunedCount: number;
}> {
  const uniqueAccounts = uniqueAdvertisers(accounts);

  if (uniqueAccounts.length === 0) {
    const deleteResult = await db.run('DELETE FROM advertiser_tracking');
    return {
      states: [],
      prunedCount: deleteResult.changes || 0,
    };
  }

  const states = await getAdvertiserTrackingStates(uniqueAccounts);
  const validAdvertiserIds = uniqueAccounts.map(account => account.advertiserId);
  const placeholders = validAdvertiserIds.map(() => '?').join(', ');
  const deleteResult = await db.run(
    `DELETE FROM advertiser_tracking WHERE advertiser_id NOT IN (${placeholders})`,
    validAdvertiserIds
  );

  return {
    states,
    prunedCount: deleteResult.changes || 0,
  };
}
