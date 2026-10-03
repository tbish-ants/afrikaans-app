// Reads the built deck (and audio) from the private vault repo's `deck` branch.
import { kv } from './store.js';

const API = 'https://api.github.com';
const AUDIO_CACHE = 'af-audio-v1';

export async function config() {
  const s = (await kv.get('settings')) || {};
  return { owner: s.owner || 'tbish-ants', repo: s.repo || 'afrikaans-vault', token: s.token || '' };
}

async function gh(path, accept = 'application/vnd.github+json') {
  const { owner, repo, token } = await config();
  if (!token) throw new Error('No GitHub token set — add one in Settings.');
  const res = await fetch(`${API}/repos/${owner}/${repo}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
    cache: 'no-store',
  });
  if (res.status === 401) throw new Error('GitHub rejected the token (401). Check it in Settings.');
  if (res.status === 404) throw new Error(`Not found on GitHub: ${path}. Has the deck been built yet?`);
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  return res;
}

/** Latest commit sha of the deck branch. */
export async function deckSha() {
  const r = await gh('/branches/deck');
  return (await r.json()).commit.sha;
}

/** Download deck.json if it changed. Returns {deck, sha, updated}. */
export async function syncDeck(force = false) {
  const sha = await deckSha();
  const cur = await kv.get('deckSha');
  if (!force && cur === sha && (await kv.get('deck'))) {
    return { deck: await kv.get('deck'), sha, updated: false };
  }
  const r = await gh(`/contents/deck.json?ref=${sha}`, 'application/vnd.github.raw+json');
  const deck = await r.json();
  await kv.set('deck', deck);
  await kv.set('deckSha', sha);
  await kv.set('deckSyncedAt', new Date().toISOString());
  return { deck, sha, updated: true };
}

const audioUrl = key => new URL(`__audio/${key}.mp3`, self.location.href).href;

export async function audioCached(key) {
  if (!key || !('caches' in self)) return false;
  const c = await caches.open(AUDIO_CACHE);
  return !!(await c.match(audioUrl(key)));
}

/** Returns a Blob for the audio clip, from cache or GitHub (then cached). */
export async function getAudio(key) {
  if (!key) return null;
  const c = await caches.open(AUDIO_CACHE);
  const hit = await c.match(audioUrl(key));
  if (hit) return hit.blob();
  const r = await gh(`/contents/audio/${key}.mp3?ref=deck`, 'application/vnd.github.raw+json');
  const blob = await r.blob();
  await c.put(audioUrl(key), new Response(blob, { headers: { 'Content-Type': 'audio/mpeg' } }));
  return blob;
}

/** Fetch many clips with limited concurrency. onProgress(done, total). */
export async function prefetchAudio(keys, onProgress, concurrency = 4) {
  const c = await caches.open(AUDIO_CACHE);
  const todo = [];
  for (const k of new Set(keys)) if (k && !(await c.match(audioUrl(k)))) todo.push(k);
  let done = 0, failed = 0;
  const total = todo.length;
  onProgress && onProgress(0, total);
  async function worker() {
    while (todo.length) {
      const k = todo.shift();
      try { await getAudio(k); } catch { failed++; }
      done++;
      onProgress && onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { total, failed };
}

/** Remove clips no longer referenced by the deck. */
export async function pruneAudio(validKeys) {
  const c = await caches.open(AUDIO_CACHE);
  const valid = new Set([...validKeys].map(audioUrl));
  for (const req of await c.keys()) if (!valid.has(req.url)) await c.delete(req);
}

export async function audioCount() {
  if (!('caches' in self)) return 0;
  const c = await caches.open(AUDIO_CACHE);
  return (await c.keys()).length;
}
