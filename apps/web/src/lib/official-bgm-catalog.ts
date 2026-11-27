import { useEffect, useState } from 'react';
import type { OfficialBgmItem } from '@yuha/contracts';
import { apiFetch } from './api';

export const OFFICIAL_BGM_CATALOG = '/v1/marketplace/bgm';
export const OFFICIAL_BGM_ADMIN = '/v1/admin/marketplace/bgm';

type Page<T> = { items: T[]; nextOffset: number | null };

export function useOfficialBgmCatalog<T extends OfficialBgmItem>(endpoint: string, query = '') {
  const [page, setPage] = useState<Page<T>>({ items: [], nextOffset: null });
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(query);
    params.set('offset', String(offset));
    apiFetch<Page<T>>(`${endpoint}?${params}`, { signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        setPage((current) => offset === 0 ? next : { ...next, items: [...current.items, ...next.items] });
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [endpoint, query, offset, revision]);

  return {
    ...page, pending, failed,
    loadMore: () => {
      if (page.nextOffset === null || pending) return;
      setPending(true);
      setOffset(page.nextOffset);
    },
    retry: () => {
      setPending(true);
      setFailed(false);
      setRevision((n) => n + 1);
    },
    reload: () => {
      setPending(true);
      setFailed(false);
      setOffset(0);
      setRevision((n) => n + 1);
    },
    replace: (item: T) => setPage((current) => ({
      ...current, items: current.items.map((previous) => previous.id === item.id ? item : previous),
    })),
  };
}
