// Hidden notes + app suggestions: stored on the phone, synced to the vault by sync.js.
import { kv } from './store.js';

// ---------------------------------------------------------------- hidden notes
// local shape: { "<v|p>:<name>": { ts: <ms>, on: true|false } }  (false = unhidden, kept so it syncs)
export async function loadHidden() { return (await kv.get('hidden')) || {}; }
export async function saveHidden(h) { await kv.set('hidden', h); }
export const hiddenIds = h => Object.keys(h).filter(k => h[k].on);

/** Merge the vault copy into the local one: newest change per note wins. */
export function mergeHidden(local, remoteTxt) {
  const out = { ...local };
  let changed = false;
  if (remoteTxt) {
    const remote = JSON.parse(remoteTxt).notes || {};
    for (const [id, [ts, on]] of Object.entries(remote)) {
      if (!out[id] || ts > out[id].ts) { out[id] = { ts, on: !!on }; changed = true; }
    }
  }
  return { merged: out, changed };
}
export function hiddenFile(h) {
  const ids = Object.keys(h).sort();
  return `{"format":"afrikaans-hidden/1","fields":["changed_ms","hidden"],\n"notes":{\n${ids.map(id => `${JSON.stringify(id)}:[${h[id].ts},${h[id].on ? 1 : 0}]`).join(',\n')}\n}}\n`;
}

// ---------------------------------------------------------------- suggestions
// [{ id, ts, text, ctx: { screen, note, noteLabel, card }, sent: bool }]
export const SUGGEST_PATH = 'Inbox/App suggestions.md';
export async function loadSuggestions() { return (await kv.get('suggestions')) || []; }
export async function addSuggestion(text, ctx) {
  const list = await loadSuggestions();
  const now = new Date();
  list.push({ id: now.getTime().toString(36) + Math.random().toString(36).slice(2, 6), ts: now.toISOString(), text: text.trim(), ctx, sent: false });
  await kv.set('suggestions', list);
  return list.filter(s => !s.sent).length;
}
export async function pendingSuggestions() { return (await loadSuggestions()).filter(s => !s.sent); }
export async function markSent(ids) {
  const set = new Set(ids);
  const list = await loadSuggestions();
  list.forEach(s => { if (set.has(s.id)) s.sent = true; });
  await kv.set('suggestions', list.slice(-200));
}

const pad = n => String(n).padStart(2, '0');
const stamp = iso => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export function ctxLabel(ctx = {}, md = false) {
  const parts = [ctx.screen];
  if (ctx.note) parts.push(md ? `[[${ctx.note}${ctx.noteLabel && ctx.noteLabel !== ctx.note ? '|' + ctx.noteLabel.replace(/[|\]]/g, '') : ''}]]` : (ctx.noteLabel || ctx.note));
  if (ctx.card) parts.push(ctx.card);
  return parts.filter(Boolean).join(' · ');
}
export function suggestionLine(s) {
  const [first, ...rest] = s.text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return `- [ ] ${stamp(s.ts)} · ${ctxLabel(s.ctx, true)} — ${first}${rest.map(l => `\n  ${l}`).join('')}`;
}
const HEADER = `---
tags: [app-suggestions]
---
# App suggestions

Ideas sent from the 💡 button in the Afrikaans app. New ones are added at the bottom each time the app saves progress.
Tick one off when it's done, or ask Claude to "review my app suggestions".

`;
/** Append pending suggestions to the vault note (skipping any already there). */
export function appendSuggestions(existing, items) {
  let txt = existing && existing.trim() ? existing.replace(/\s*$/, '\n') : HEADER;
  for (const s of items) {
    const line = suggestionLine(s);
    if (!txt.includes(line)) txt += line + '\n';
  }
  return txt;
}
