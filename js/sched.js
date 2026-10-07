// Cards, spaced repetition (FSRS) and study sessions.
import { fsrs, generatorParameters, createEmptyCard, Rating, State } from '../vendor/ts-fsrs.mjs';
import { cards as cardStore, log as logStore } from './store.js';

export { Rating, State };

export const TYPE_LABEL = { ar: 'Meaning', ra: 'Say it in Afrikaans', cz: 'Fill the gap' };

let F = fsrs(generatorParameters({ request_retention: 0.9, maximum_interval: 365, enable_fuzz: true }));
export function configure({ retention = 0.9 } = {}) {
  F = fsrs(generatorParameters({ request_retention: retention, maximum_interval: 365, enable_fuzz: true }));
}

/** All card definitions derived from the deck. */
export function buildCards(deck) {
  const out = [];
  for (const [iid, it] of Object.entries(deck.items)) {
    out.push({ id: iid + '|ar', item: iid, type: 'ar' });
    out.push({ id: iid + '|ra', item: iid, type: 'ra' });
    if (it.t === 'p' && it.cloze && it.cloze.length) out.push({ id: iid + '|cz', item: iid, type: 'cz' });
  }
  return out;
}

// ---- persistence (dates <-> ISO strings)
const DATE_KEYS = ['due', 'last_review'];
function revive(c) {
  const f = { ...c.fsrs };
  for (const k of DATE_KEYS) if (f[k]) f[k] = new Date(f[k]);
  return { ...c, fsrs: f };
}
function freeze(c) {
  const f = { ...c.fsrs };
  for (const k of DATE_KEYS) if (f[k] instanceof Date) f[k] = f[k].toISOString();
  return { ...c, fsrs: f };
}
export async function loadStates() {
  const m = new Map();
  for (const c of await cardStore.all()) m.set(c.id, revive(c));
  return m;
}

/** Start of the "study day" (4am local). */
export function dayStart(now = new Date()) {
  const d = new Date(now);
  if (d.getHours() < 4) d.setDate(d.getDate() - 1);
  d.setHours(4, 0, 0, 0);
  return d;
}
export function dayEnd(now = new Date()) {
  const d = dayStart(now); d.setDate(d.getDate() + 1); return d;
}

export function isDue(st, now = new Date()) {
  if (!st) return false;
  const due = st.fsrs.due;
  // learning/relearning: exact time; review: anything due today
  if (st.fsrs.state === State.Learning || st.fsrs.state === State.Relearning) return due <= now;
  return due < dayEnd(now);
}

/** Can this new card be introduced yet? Production & gap-fill wait until the meaning card was seen on an earlier day. */
function unlocked(card, states, now) {
  if (card.type === 'ar') return true;
  const ar = states.get(card.item + '|ar');
  return !!(ar && ar.introduced && new Date(ar.introduced) < dayStart(now));
}

export function newOrder(deckItems, order) {
  return (a, b) => {
    const fa = deckItems[a.item].first || '', fb = deckItems[b.item].first || '';
    const t = { ar: 0, ra: 1, cz: 2 };
    if (order === 'random') return 0;
    const c = order === 'oldest' ? fa.localeCompare(fb) : fb.localeCompare(fa);
    return c || a.item.localeCompare(b.item) || t[a.type] - t[b.type];
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function counts({ allCards, states, deck, settings, now = new Date(), filter = null }) {
  const start = dayStart(now);
  let due = 0, newAvail = 0, introducedToday = 0, learned = 0;
  for (const s of states.values()) {
    if (s.introduced && new Date(s.introduced) >= start) introducedToday++;
  }
  for (const c of allCards) {
    if (filter && !filter(c, deck.items[c.item])) continue;
    const s = states.get(c.id);
    if (s) { learned++; if (isDue(s, now)) due++; }
    else if (unlocked(c, states, now)) newAvail++;
  }
  const newLeft = Math.max(0, (settings.newPerDay ?? 15) - introducedToday);
  return { due, newAvail, newToday: Math.min(newLeft, newAvail), introducedToday, learned };
}

/**
 * Build a study queue.
 * mode 'daily': due cards + new cards up to the daily limit.
 * mode 'cram':  any cards matching the filter, due first, then the rest (incl. new), shuffled; size-limited.
 * mode 'words' / 'learning': the Home word buttons (see wordPools).
 */
export function buildQueue({ allCards, states, deck, settings, now = new Date(), filter = null, mode = 'daily', size = 0 }) {
  const start = dayStart(now);
  const pass = c => !filter || filter(c, deck.items[c.item]);
  const typesOn = settings.cardTypes || { ar: true, ra: true, cz: true };
  const cands = allCards.filter(c => typesOn[c.type] !== false && pass(c));

  // items already reviewed today (bury siblings)
  const reviewedToday = new Set();
  for (const s of states.values()) {
    if (s.fsrs.last_review && s.fsrs.last_review >= start) reviewedToday.add(s.id.split('|')[0]);
  }

  const due = [], fresh = [], other = [];
  for (const c of cands) {
    const s = states.get(c.id);
    if (s) (isDue(s, now) ? due : other).push(c);
    else if (mode === 'cram' || unlocked(c, states, now)) fresh.push(c);
  }
  // most overdue first
  due.sort((a, b) => states.get(a.id).fsrs.due - states.get(b.id).fsrs.due);
  fresh.sort(newOrder(deck.items, settings.newOrder || 'newest'));
  if ((settings.newOrder || 'newest') === 'random') shuffle(fresh);

  const seen = new Set();
  const take = (list, max) => {
    const out = [];
    for (const c of list) {
      if (out.length >= max) break;
      if (seen.has(c.item)) continue;
      if (mode === 'daily' && reviewedToday.has(c.item) && !isLearning(states.get(c.id))) continue;
      seen.add(c.item); out.push(c);
    }
    return out;
  };

  if (mode === 'words' || mode === 'learning') {
    const pools = wordPools({ allCards: cands, states, deck, settings, now });
    return shuffle((mode === 'words' ? pools.fresh : pools.learning).slice(0, size || WORD_SESSION).map(n => n.card));
  }
  if (mode === 'new') {
    // only cards never studied: meaning cards for unseen notes, plus say-it/gap cards once unlocked.
    // Ignores the daily new-card limit (you chose to do this), still one card per note.
    return take(shuffle(fresh.slice()).sort((a, b) => ({ ar: 0, ra: 1, cz: 2 }[a.type] - { ar: 0, ra: 1, cz: 2 }[b.type])), size || 25);
  }
  if (mode === 'cram') {
    const max = size || 20;
    const a = take(shuffle(due), max);
    const b = take(shuffle([...other, ...fresh]), max - a.length);
    return shuffle([...a, ...b]);
  }
  const { newToday } = counts({ allCards, states, deck, settings, now });
  const revs = take(due, settings.maxReviews || 200);
  const news = take(fresh, newToday);
  // interleave: one new card after every few reviews
  const q = [];
  const gap = news.length ? Math.max(1, Math.floor(revs.length / news.length)) : 0;
  let ni = 0;
  revs.forEach((c, i) => { q.push(c); if (gap && (i + 1) % gap === 0 && ni < news.length) q.push(news[ni++]); });
  while (ni < news.length) q.push(news[ni++]);
  return q;
}

// ---------------------------------------------------------------- Home word buttons
export const WORD_SESSION = 20;
const NEW_MAX_REPS = 2;     // "new words" = never seen, or seen at most this many times in total
const MATURE = 21;          // same as stats.js MATURE_DAYS
const TYPE_ORDER = { ar: 0, ra: 1, cz: 2 };

/**
 * Vocab notes split for the Home buttons (one card picked per note):
 *  fresh    — never studied, or ≤2 reviews in total (not marked known). Never-seen first, in the new-card order.
 *  learning — started, >2 reviews, not every card mature. Weakest first: most lapses, lowest recall, most overdue.
 * allCards should already exclude hidden notes.
 */
export function wordPools({ allCards, states, deck, settings, now = new Date() }) {
  const typesOn = settings.cardTypes || { ar: true, ra: true, cz: true };
  const byNote = new Map();
  for (const c of allCards) {
    const it = deck.items[c.item];
    if (!it || it.t !== 'v' || typesOn[c.type] === false) continue;
    if (!byNote.has(c.item)) byNote.set(c.item, []);
    byNote.get(c.item).push(c);
  }
  const fresh = [], learning = [];
  for (const [item, cs] of byNote) {
    cs.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
    const started = cs.filter(c => states.has(c.id));
    const ss = started.map(c => states.get(c.id));
    const reps = ss.reduce((a, s) => a + (s.fsrs.reps || 0), 0);
    if (reps <= NEW_MAX_REPS) {
      if (ss.some(s => s.known)) continue;   // marked "already know these"
      // a due card first, then an unseen card that's unlocked, then any started card, then the meaning card
      const card = started.find(c => isDue(states.get(c.id), now))
        || cs.find(c => !states.has(c.id) && unlocked(c, states, now))
        || started[0] || cs[0];
      fresh.push({ item, card, seen: started.length > 0, first: deck.items[item].first || '' });
      continue;
    }
    const mature = cs.every(c => { const s = states.get(c.id); return s && s.fsrs.state === State.Review && (s.fsrs.scheduled_days || 0) >= MATURE; });
    if (mature) continue;
    let card = null, minR = 2, lapses = 0, overdue = -Infinity;
    for (const c of started) {
      const f = states.get(c.id).fsrs;
      const r = f.state === State.New ? 0 : F.get_retrievability(f, now, false);
      lapses = Math.max(lapses, f.lapses || 0);
      overdue = Math.max(overdue, now - f.due);
      if (r < minR) { minR = r; card = c; }
    }
    learning.push({ item, card: card || started[0], lapses, r: minR, overdue });
  }
  const order = settings.newOrder || 'newest';
  fresh.sort((a, b) => (a.seen - b.seen) || (order === 'oldest' ? a.first.localeCompare(b.first) : b.first.localeCompare(a.first)) || a.item.localeCompare(b.item));
  if (order === 'random') { const unseen = fresh.filter(n => !n.seen), seen = fresh.filter(n => n.seen); fresh.splice(0, fresh.length, ...shuffle(unseen), ...shuffle(seen)); }
  learning.sort((a, b) => b.lapses - a.lapses || a.r - b.r || b.overdue - a.overdue);
  return { fresh, learning };
}

const isLearning = s => s && (s.fsrs.state === State.Learning || s.fsrs.state === State.Relearning);

/** Preview the next due date for each rating. */
export function preview(state, now = new Date()) {
  const card = state ? state.fsrs : createEmptyCard(now);
  const r = F.repeat(card, now);
  return { 1: r[Rating.Again].card.due, 2: r[Rating.Hard].card.due, 3: r[Rating.Good].card.due, 4: r[Rating.Easy].card.due };
}

/** Apply a rating; persists state + log. Returns the new state. */
export async function answer(cardDef, state, rating, { now = new Date(), typed = null, verdict = null, ms = 0, mode = 'daily' } = {}) {
  const card = state ? state.fsrs : createEmptyCard(now);
  const { card: next } = F.next(card, now, rating);
  const st = { id: cardDef.id, fsrs: next, introduced: state?.introduced || now.toISOString() };
  await cardStore.put(freeze(st));
  await logStore.add({ ts: now.toISOString(), id: cardDef.id, rating, prevState: card.state, verdict, typed, ms, mode });
  return st;
}

/** Mark a set of new cards as already known (one "Easy" rating each). */
export async function markKnown(cardDefs, states, now = new Date()) {
  const list = [];
  for (const c of cardDefs) {
    if (states.get(c.id)) continue;
    const { card } = F.next(createEmptyCard(now), now, Rating.Easy);
    const st = { id: c.id, fsrs: card, introduced: new Date(now - 864e5).toISOString(), known: true };
    list.push(freeze(st));
    states.set(c.id, st);
  }
  await cardStore.putMany(list);
  return list.length;
}

export function fmtInterval(due, now = new Date()) {
  const m = (due - now) / 6e4;
  if (m < 1) return '<1m';
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

/** Session runner: handles re-showing learning cards within the session. */
export class Session {
  constructor(queue, states, mode = 'daily') {
    this.queue = queue.slice();
    this.states = states;
    this.mode = mode;
    this.learning = []; // {card, due}
    this.done = 0;
    this.total = queue.length;
  }
  remaining() { return this.queue.length + this.learning.length; }
  next(now = new Date()) {
    this.learning.sort((a, b) => a.due - b.due);
    if (this.learning.length && this.learning[0].due <= now) return this.learning.shift().card;
    if (this.queue.length) return this.queue.shift();
    if (this.learning.length) return this.learning.shift().card;  // nothing else: show early
    return null;
  }
  async rate(card, rating, extra = {}) {
    const now = new Date();
    const st = await answer(card, this.states.get(card.id), rating, { ...extra, now, mode: this.mode });
    this.states.set(card.id, st);
    this.done++;
    if (st.fsrs.due - now < 30 * 6e4) this.learning.push({ card, due: st.fsrs.due });
    return st;
  }
}
