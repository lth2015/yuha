import { useState } from 'react';
import {
  BGM_GENRES, BGM_MOODS, BGM_SCENARIOS, OFFICIAL_BGM_COVER_BYTES, OFFICIAL_BGM_DOCUMENT_BYTES, OFFICIAL_BGM_MASTER_BYTES,
  officialBgmCoverFor, officialBgmInventoryFor, officialBgmInventoryReport, parseOfficialBgmManifest,
  type OfficialBgmBatchTrack, type OfficialBgmInventoryReport, type OfficialBgmManifestIssue, type OfficialBgmUploadResult,
} from '@yuha/contracts';
import { apiFetch } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { OFFICIAL_BGM_ADMIN } from '../../lib/official-bgm-catalog';

type Entry = ReturnType<typeof parseOfficialBgmManifest>[number];
type Tags = Pick<Entry, 'genre' | 'mood' | 'scenario'>;
type Batch = { entries: Entry[]; rejected: OfficialBgmManifestIssue[]; files: Map<string, File>; name: string };
type Prepared = { id: string; entry: Entry; master?: File; cover?: File; track?: OfficialBgmBatchTrack;
  issue?: string; reason?: string; notes?: string[] };
type Outcome = { status: 'checking' | 'sending' | 'imported' | 'existing' | 'failed'; problem?: string };
const TAGS = { genre: BGM_GENRES, scenario: BGM_SCENARIOS, mood: BGM_MOODS } as const;
const LABELS = ['genre', 'scenario', 'mood'] as const;

async function readReport(file: File): Promise<OfficialBgmInventoryReport> {
  if (file.size > OFFICIAL_BGM_DOCUMENT_BYTES) throw new Error('inventory.json is too large');
  return officialBgmInventoryReport.parse(JSON.parse(await file.text()));
}

function prepare(entry: Entry, files: Map<string, File>, report: OfficialBgmInventoryReport | undefined, covers: string[]) {
  const original = entry.provenance;
  const master = files.get(`masters/${original.masterFilename}`);
  if (!master || !master.size || master.size > OFFICIAL_BGM_MASTER_BYTES) return { issue: 'market.import.masterMissing' };
  const coverName = officialBgmCoverFor(original, covers);
  const cover = coverName ? files.get(`covers/${coverName}`) : undefined;
  if (coverName && (!cover || !cover.size || cover.size > OFFICIAL_BGM_COVER_BYTES)) return { issue: 'market.import.coverMissing' };
  const record = officialBgmInventoryFor(report, original);
  if (record?.evidence.bytes !== undefined && record.evidence.bytes !== master.size) return { issue: 'market.import.inventorySize' };
  if (!entry.genre || !entry.scenario || !entry.mood) return { issue: 'market.import.chooseTags', notes: record?.notes };
  const track: OfficialBgmBatchTrack = {
    title: entry.title, genre: entry.genre, scenario: entry.scenario, mood: entry.mood,
    provenance: { ...original, ...(coverName ? { coverFilename: coverName } : {}) },
    inventory: record?.evidence,
  };
  return { track, master, cover, notes: record?.notes };
}

export function OfficialBgmBatchImport({ onImported }: { onImported: () => void }) {
  const { t } = useI18n();
  const [batch, setBatch] = useState<Batch>();
  const [report, setReport] = useState<OfficialBgmInventoryReport>();
  const [tags, setTags] = useState<Record<string, Tags>>({});
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [badReport, setBadReport] = useState(false);

  async function selectFolder(selected: FileList | null) {
    if (!selected?.length) return;
    setLoading(true);
    setProblem('');
    setBatch(undefined);
    setReport(undefined);
    setBadReport(false);
    setTags({});
    setOutcomes({});
    try {
      const files = new Map<string, File>();
      const first = selected[0]!.webkitRelativePath.split('/');
      const name = first[0]!;
      for (const file of Array.from(selected)) {
        const [folder, ...relative] = file.webkitRelativePath.split('/');
        if (folder === name) files.set(relative.join('/'), file);
      }
      const manifest = files.get('manifest.csv');
      if (!manifest || manifest.size > OFFICIAL_BGM_DOCUMENT_BYTES) throw new Error(t('market.import.manifest'));
      const rejected: OfficialBgmManifestIssue[] = [];
      const entries = parseOfficialBgmManifest(await manifest.text(), name, (issue) => rejected.push(issue));
      setBatch({ entries, rejected, files, name });
      const inventory = files.get('inventory.json');
      if (inventory) {
        try { setReport(await readReport(inventory)); }
        catch { setBadReport(true); }
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : t('market.import.manifest'));
    } finally {
      setLoading(false);
    }
  }

  async function selectReport(file: File | undefined) {
    if (!file) return;
    setLoading(true);
    setProblem('');
    try {
      setReport(await readReport(file));
      setBadReport(false);
    } catch {
      setReport(undefined);
      setBadReport(true);
    }
    finally { setLoading(false); }
  }

  const covers = batch ? [...batch.files.keys()].filter((key) => /^covers\/[^/]+$/.test(key)).map((key) => key.slice(7)) : [];
  const rows = batch?.entries.map<Prepared>((row) => {
    const id = row.provenance.trackId;
    const entry = { ...row, ...tags[id] };
    try {
      return { id, entry, ...prepare(entry, batch.files, report, covers) };
    } catch (error) {
      return { id, entry, issue: undefined, reason: error instanceof Error ? error.message : t('market.import.badReport') };
    }
  }) ?? [];
  const pending = rows.filter((row) => row.track && row.master &&
    outcomes[row.id]?.status !== 'imported' && outcomes[row.id]?.status !== 'existing');

  async function upload(selected: Prepared[]) {
    setBusy(true);
    let changed = false;
    try {
      for (const row of selected) {
        if (!row.track || !row.master) continue;
        try {
          if (row.track.inventory && globalThis.crypto?.subtle) {
            setOutcomes((current) => ({ ...current, [row.id]: { status: 'checking' } }));
            const digest = await crypto.subtle.digest('SHA-256', await row.master.arrayBuffer());
            const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
            if (hex !== row.track.inventory.sha256) throw new Error(t('market.import.inventoryHash'));
          }
          setOutcomes((current) => ({ ...current, [row.id]: { status: 'sending' } }));
          const form = new FormData();
          form.append('fields', JSON.stringify({ track: row.track }));
          form.append('master', row.master);
          if (row.cover) form.append('cover', row.cover);
          const result = await apiFetch<OfficialBgmUploadResult>(`${OFFICIAL_BGM_ADMIN}/import`, { method: 'POST', body: form });
          changed = true;
          setOutcomes((current) => ({ ...current, [row.id]: { status: result.status } }));
        } catch (error) {
          setOutcomes((current) => ({ ...current, [row.id]: {
            status: 'failed', problem: error instanceof Error ? error.message : t('market.import.failed'),
          } }));
        }
      }
    } finally {
      if (changed) onImported();
      setBusy(false);
    }
  }

  return (
    <details className="market-import">
      <summary>{t('market.import.title')}</summary>
      <div className="stack">
        <p className="small muted">{t('market.import.description')}</p>
        <label className="field">
          <span>{t('market.import.folder')}</span>
          <input type="file" multiple {...{ webkitdirectory: '' }} disabled={busy || loading}
            onChange={(event) => { void selectFolder(event.target.files); event.target.value = ''; }} />
        </label>
        {batch && (
          <>
            <label className="field">
              <span>{t('market.import.report')}</span>
              <input type="file" accept=".json,application/json" disabled={busy || loading}
                onChange={(event) => { void selectReport(event.target.files?.[0]); event.target.value = ''; }} />
            </label>
            {(report || badReport) && <button type="button" className="btn market-import__clear" disabled={busy || loading}
              onClick={() => { setReport(undefined); setBadReport(false); }}>{t('market.import.clearReport')}</button>}
            {report?.batch_problems?.length ? <p className="small muted">{report.batch_problems.join(' · ')}</p> : null}
            <ul className="market-import__rows" aria-label={batch.name}>
              {batch.rejected.map((issue) => (
                <li key={`issue-${issue.row}`}>
                  <strong>{issue.title || issue.id}</strong>
                  <p className="small" role="alert">{t('market.import.rowError', { row: issue.row, message: issue.message })}</p>
                </li>
              ))}
              {rows.map((row) => {
                const outcome = outcomes[row.id];
                const done = outcome?.status === 'imported' || outcome?.status === 'existing';
                return (
                  <li key={row.id}>
                    <strong>{row.entry.title}</strong>
                    <span className="small muted">{row.entry.provenance.masterFilename}</span>
                    {(!row.entry.genre || !row.entry.scenario || !row.entry.mood || tags[row.id]) && !done && (
                      <div className="market-import__tags">
                        {LABELS.map((key) => (
                          <label className="field" key={key}>
                            <span>{t(`bgm.${key}`)}</span>
                            <select disabled={busy} value={row.entry[key] ?? ''} onChange={(event) => {
                              const value = event.target.value || undefined;
                              setTags((current) => ({ ...current, [row.id]: { ...current[row.id], [key]: value } }));
                            }}>
                              <option value="">{t('market.import.chooseTag')}</option>
                              {TAGS[key].map((value) => <option value={value} key={value}>{t(`bgm.${key}.${value}`)}</option>)}
                            </select>
                          </label>
                        ))}
                      </div>
                    )}
                    <span className="small" aria-live={outcome ? 'polite' : 'off'}>
                      {outcome ? t(`market.import.${outcome.status}`) : row.reason || (row.issue ? t(row.issue) : t('market.import.ready'))}
                    </span>
                    {outcome?.problem && <p className="small" role="alert">{outcome.problem}</p>}
                    {outcome?.status === 'failed' && row.track && (
                      <button type="button" className="btn market-import__clear" disabled={busy || loading || badReport}
                        onClick={() => void upload([row])}>{t('market.retry')}</button>
                    )}
                    {row.notes?.length ? <p className="small muted">{row.notes.join(' · ')}</p> : null}
                  </li>
                );
              })}
            </ul>
            <button className="btn btn--primary market-import__submit" type="button" disabled={busy || loading || badReport || !pending.length}
              onClick={() => void upload(pending)}>{t(busy ? 'market.import.sending' : 'market.import.submit')}</button>
          </>
        )}
        {loading && <p role="status">{t('market.import.reading')}</p>}
        {badReport && <p className="small" role="alert">{t('market.import.badReport')}</p>}
        {problem && <p className="small" role="alert">{problem}</p>}
      </div>
    </details>
  );
}
