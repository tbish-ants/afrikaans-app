// Progress sync: phone <-> vault repo (_app/progress/*) plus the Obsidian dashboards.
import { api } from './github.js';
import { kv, cards as cardStore, log as logStore } from './store.js';
import { loadStates, buildCards } from './sched.js';
import { computeStats } from './stats.js';
import { dashboardFiles } from './obsidian.js';
import { loadHidden, saveHidden, mergeHidden, hiddenFile, hiddenIds, pendingSuggestions, appendSuggestions, markSent, SUGGEST_PATH } from './extras.js';

const DIR = '_app/progress';
const sec = d => (d ? Math.round(new Date(d).getTime() / 1000) : 0);
const fromSec = s => (s ? new Date(s * 1000) : undefined);
const r4 = x => Math.round((x || 0) * 1e4) / 1e4;
const VERDICT = ['exact', 'accent', 'close', 'wrong'];
const MODE = { daily: 'd', cram: 'c', new: 'n' };
const MODE_R = { d: 'daily', c: 'cram', n: 'new' };

// ---------------------------------------------------------------- (de)serialise
function cardToRow(st) {
  const f = st.fsrs;
  return [sec(f.due), r4(f.stability), r4(f.difficulty), f.elapsed_days || 0, f.scheduled_days || 0,
    f.learning_steps || 0, f.reps || 0, f.lapses || 0, f.state || 0, sec(f.last_review), sec(st.introduced), st.known ? 1 : 0];
}
function rowToCard(id, r) {
  return {
    id,
    fsrs: { due: fromSec(r[0]), stability: r[1], difficulty: r[2], elapsed_days: r[3], scheduled_days: r[4],
      learning_steps: r[5], reps: r[6], lapses: r[7], state: r[8], last_review: fromSec(r[9]) },
    introduced: r[10] ? new Date(r[10] * 1000).toISOString() : undefined,
    ...(r[11] ? { known: true } : {}),
  };
}
const freezeFsrs = c => ({ ...c, fsrs: { ...c.fsrs, due: c.fsrs.due?.toISOString?.() ?? c.fsrs.due, last_review: c.fsrs.last_review?.toISOString?.() ?? c.fsrs.last_review } });

function cardsFile(states) {
  const ids = [...states.keys()].sort();
  const lines = ids.map(id => `${JSON.stringify(id)}:${JSON.stringify(cardToRow(states.get(id)))}`);
  return `{"format":"afrikaans-progress/1",\n"fields":["due","stability","difficulty","elapsed_days","scheduled_days","learning_steps","reps","lapses","state","last_review","introduced","known"],\n"cards":{\n${lines.join(',\n')}\n}}\n`;
}
const ms = d => new Date(d).getTime();
const logKey = l => `${ms(l.ts)}|${l.id}`;
const logToLine = l => JSON.stringify([ms(l.ts), l.id, l.rating, l.prevState ?? 0, l.verdict ? VERDICT.indexOf(l.verdict) : -1, Math.round((l.ms || 0) / 100), MODE[l.mode] || 'd']);
const lineToLog = a => ({ ts: new Date(a[0] > 1e11 ? a[0] : a[0] * 1000).toISOString(), id: a[1], rating: a[2], prevState: a[3], verdict: a[4] >= 0 ? VERDICT[a[4]] : null, ms: a[5] * 100, mode: MODE_R[a[6]] || 'daily' });
const monthOf = ts => ts.slice(0, 7);

// ---------------------------------------------------------------- remote reads
async function getText(path) {
  const r = await api(`/contents/${encodeURI(path)}?ref=main`, { accept: 'application/vnd.github.raw+json', allow: [404] });
  return r.status === 404 ? null : r.text();
}
async function listDir(path) {
  const r = await api(`/contents/${encodeURI(path)}?ref=main`, { allow: [404] });
  if (r.status === 404) return [];
  const j = await r.json();
  return Array.isArray(j) ? j.map(x => x.name) : [];
}

// ---------------------------------------------------------------- multi-file commit (Git Data API)
async function commitFiles(files, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await (await api('/git/ref/heads/main')).json();
    const head = ref.object.sha;
    const commit = await (await api(`/git/commits/${head}`)).json();
    const tree = [];
    for (const [path, value] of Object.entries(files)) {
      // a function is re-run on each attempt, so it builds on the latest copy in the vault
      const content = typeof value === 'function' ? await value() : value;
      const b = await (await api('/git/blobs', { method: 'POST', body: { content, encoding: 'utf-8' } })).json();
      tree.push({ path, mode: '100644', type: 'blob', sha: b.sha });
    }
    const t = await (await api('/git/trees', { method: 'POST', body: { base_tree: commit.tree.sha, tree } })).json();
    if (t.sha === commit.tree.sha) return { committed: false };
    const c = await (await api('/git/commits', { method: 'POST', body: { message, tree: t.sha, parents: [head] } })).json();
    const r = await api('/git/refs/heads/main', { method: 'PATCH', body: { sha: c.sha, force: false }, allow: [409, 422] });
    if (r.ok) return { committed: true, sha: c.sha };
    // someone else pushed in between (e.g. the laptop) — rebuild on the new head
  }
  throw new Error('Could not save progress to GitHub (the vault kept changing). Try again in a minute.');
}

// ---------------------------------------------------------------- main entry
/**
 * Merge local progress with the vault copy, then write progress + dashboards.
 * Returns {restored, pushed, committed}.
 */
export async function syncProgress({ deck, onStatus = () => {} } = {}) {
  onStatus('Fetching saved progress…');
  const localStates = await loadStates();
  const localLogs = await logStore.all();
  const restoring = localLogs.length === 0 && localStates.size === 0;

  // ---- cards: newest review wins
  const remoteTxt = await getText(`${DIR}/cards.json`);
  let pulledCards = 0;
  if (remoteTxt) {
    const remote = JSON.parse(remoteTxt).cards || {};
    const updates = [];
    for (const [id, row] of Object.entries(remote)) {
      const loc = localStates.get(id);
      const remoteLR = row[9] || 0, localLR = loc ? sec(loc.fsrs.last_review) : -1;
      if (!loc || remoteLR > localLR) {
        const c = rowToCard(id, row);
        localStates.set(id, c);
        updates.push(freezeFsrs(c));
      }
    }
    if (updates.length) { await cardStore.putMany(updates); pulledCards = updates.length; }
  }

  // ---- hidden notes: newest change per note wins
  const remoteHidden = await getText(`${DIR}/hidden.json`);
  const { merged: hidden, changed: hiddenPulled } = mergeHidden(await loadHidden(), remoteHidden);
  if (hiddenPulled) await saveHidden(hidden);
  const hiddenTxt = Object.keys(hidden).length ? hiddenFile(hidden) : null;
  const hiddenChanged = hiddenTxt !== null && hiddenTxt !== remoteHidden;

  // ---- review log: monthly files, union by (time, card)
  const remoteMonths = (await listDir(DIR)).filter(n => /^log-\d{4}-\d{2}\.jsonl$/.test(n)).map(n => n.slice(4, 11));
  const localByMonth = new Map();
  for (const l of localLogs) {
    const m = monthOf(l.ts);
    if (!localByMonth.has(m)) localByMonth.set(m, []);
    localByMonth.get(m).push(l);
  }
  const lastSynced = (await kv.get('progressSyncedMonths')) || {};
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const months = new Set([...localByMonth.keys(), ...(restoring ? remoteMonths : remoteMonths.filter(m => m >= thisMonth || !(m in lastSynced)))]);
  const files = {};
  const newLocal = [];
  for (const m of [...months].sort()) {
    const loc = localByMonth.get(m) || [];
    const unsentLocal = loc.length !== (lastSynced[m] || 0);
    let remote = [], fetched = false;
    if (remoteMonths.includes(m) && (unsentLocal || restoring || m >= thisMonth || !(m in lastSynced))) {
      fetched = true;
      const txt = await getText(`${DIR}/log-${m}.jsonl`);
      remote = (txt || '').split('\n').filter(Boolean).map(s => lineToLog(JSON.parse(s)));
    }
    const keys = new Set(loc.map(logKey));
    const merged = [...loc];
    for (const r of remote) if (!keys.has(logKey(r))) { merged.push(r); newLocal.push(r); keys.add(logKey(r)); }
    merged.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const remoteExists = remoteMonths.includes(m);
    if ((fetched && merged.length !== remote.length) || (!remoteExists && merged.length)) {
      if (merged.length) files[`${DIR}/log-${m}.jsonl`] = merged.map(logToLine).join('\n') + '\n';
    }
    lastSynced[m] = merged.length;
  }
  if (newLocal.length) await logStore.addMany(newLocal);

  // ---- write cards + dashboards (skip entirely if nothing changed)
  const cardsTxt = cardsFile(localStates);
  const progressChanged = !(cardsTxt === remoteTxt || (!remoteTxt && localStates.size === 0)) || Object.keys(files).length > 0 || hiddenChanged;
  const suggestions = await pendingSuggestions();
  const base = { pulledCards, pulledReviews: newLocal.length, hiddenPulled, suggestions: 0 };
  if (!progressChanged && !suggestions.length) {
    await kv.set('progressSyncedMonths', lastSynced);
    await kv.set('progressSyncedAt', now.toISOString());
    await kv.del('syncPending');
    return { ...base, restored: false, committed: false };
  }
  if (progressChanged) {
    files[`${DIR}/cards.json`] = cardsTxt;
    if (hiddenTxt) files[`${DIR}/hidden.json`] = hiddenTxt;
    if (deck) {
      onStatus('Updating dashboards…');
      const allLogs = await logStore.all();
      const stats = computeStats({ deck, cards: buildCards(deck), states: localStates, logs: allLogs, now });
      Object.assign(files, dashboardFiles(stats, deck, hiddenIds(hidden)));
    }
  }
  if (suggestions.length) files[SUGGEST_PATH] = async () => appendSuggestions(await getText(SUGGEST_PATH), suggestions);
  onStatus('Saving to GitHub…');
  const when = now.toISOString().slice(0, 16).replace('T', ' ');
  const msg = progressChanged ? `App progress ${when}${suggestions.length ? ` + ${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}` : ''}` : `App suggestion${suggestions.length === 1 ? '' : 's'} ${when}`;
  const res = await commitFiles(files, msg);
  if (suggestions.length) await markSent(suggestions.map(x => x.id));
  await kv.set('progressSyncedMonths', lastSynced);
  await kv.set('progressSyncedAt', now.toISOString());
  await kv.del('syncPending');
  return { ...base, suggestions: suggestions.length, restored: restoring && (pulledCards > 0 || newLocal.length > 0), committed: res.committed };
}
