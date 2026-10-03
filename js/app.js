import { kv, cards as cardStore, log as logStore } from './store.js';
import * as gh from './github.js';
import { check, englishVariants, diffHtml } from './check.js';
import {
  buildCards, loadStates, counts, buildQueue, Session, preview, fmtInterval,
  markKnown, dayStart, TYPE_LABEL, Rating, configure,
} from './sched.js';
import { syncProgress } from './sync.js';
import { computeStats } from './stats.js';
import { heatmapSvg, forecastSvg, stagesSvg, APP_PALETTE } from './charts.js';

const $app = document.getElementById('app');
const DEFAULTS = {
  owner: 'tbish-ants', repo: 'afrikaans-vault', token: '',
  newPerDay: 15, maxReviews: 200, newOrder: 'newest', retention: 0.9,
  typeProduction: true, typeRecognition: false, strictAccents: false, autoplay: true,
  cardTypes: { ar: true, ra: true, cz: true },
};

const S = { settings: { ...DEFAULTS }, deck: null, allCards: [], states: new Map(), session: null };

// ---------------------------------------------------------------- utils
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>')
  .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => esc(b || a));
const ICON = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/></svg>',
};

let toastT;
function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

async function saveSettings(patch) {
  S.settings = { ...S.settings, ...patch };
  await kv.set('settings', S.settings);
  configure({ retention: S.settings.retention });
}

function itemInfo(it) {
  if (it.t === 'v') return [it.pos, it.level].filter(Boolean).join(' · ');
  return [it.kind === 'sentence' ? 'sentence' : it.kind, it.level].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- audio
let currentAudio;
async function play(key, btn) {
  if (!key) return;
  try {
    const blob = await gh.getAudio(key);
    if (currentAudio) { currentAudio.pause(); URL.revokeObjectURL(currentAudio.src); }
    currentAudio = new Audio(URL.createObjectURL(blob));
    btn && btn.classList.add('playing');
    currentAudio.onended = () => btn && btn.classList.remove('playing');
    await currentAudio.play();
  } catch (e) {
    btn && btn.classList.remove('playing');
    if (!navigator.onLine) toast('Audio not downloaded yet (offline)');
  }
}
const audioBtn = key => key ? `<button class="icon-btn audio-btn" data-audio="${key}" aria-label="Play audio">${ICON.speaker}</button>` : '';
function wireAudio(root = $app) {
  root.querySelectorAll('[data-audio]').forEach(b => b.onclick = () => play(b.dataset.audio, b));
}

// ---------------------------------------------------------------- data
async function loadAll() {
  S.settings = { ...DEFAULTS, ...((await kv.get('settings')) || {}) };
  configure({ retention: S.settings.retention });
  S.deck = await kv.get('deck');
  if (S.deck) S.allCards = buildCards(S.deck);
  S.states = await loadStates();
}

async function syncDeck({ force = false, quiet = false } = {}) {
  if (!S.settings.token) { if (!quiet) toast('Add your GitHub token in Settings first'); return false; }
  if (!navigator.onLine) { if (!quiet) toast('Offline — using the saved deck'); return false; }
  try {
    const before = S.deck ? Object.keys(S.deck.items).length : 0;
    const { deck, updated } = await gh.syncDeck(force);
    if (updated) {
      S.deck = deck; S.allCards = buildCards(deck);
      const after = Object.keys(deck.items).length;
      toast(before ? `Deck updated (${after - before >= 0 ? '+' : ''}${after - before} notes)` : `Deck downloaded: ${after} notes`);
      gh.pruneAudio(Object.values(deck.items).map(i => i.audio).filter(Boolean)).catch(() => {});
    } else if (!quiet) toast('Deck is up to date');
    return true;
  } catch (e) {
    if (!quiet) toast(e.message, 4500);
    return false;
  }
}

// ---------------------------------------------------------------- progress sync
let syncing = null;
async function saveProgress({ quiet = false } = {}) {
  if (!S.settings.token || !navigator.onLine || !S.deck) return false;
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const r = await syncProgress({ deck: S.deck });
      S.states = await loadStates();
      if (r.restored) toast(`Restored your progress from the vault (${r.pulledCards} cards)`, 4000);
      else if (!quiet && r.committed) toast('Progress saved to your vault');
      return true;
    } catch (e) {
      if (!quiet || /Read and write/.test(e.message)) toast(e.message, 5000);
      return false;
    } finally { syncing = null; }
  })();
  return syncing;
}
async function progressDirty() {
  const at = await kv.get('progressSyncedAt');
  if (!at) return true;
  return (await logStore.since(at)).length > 0;
}

// ---------------------------------------------------------------- router
const routes = { home, study, practice, settings: settingsView, setup, progress: progressView };
function go(view, params = {}) {
  history.pushState({ view, params }, '', '#' + view);
  render(view, params);
}
window.addEventListener('popstate', e => {
  const st = e.state || { view: 'home', params: {} };
  render(st.view, st.params || {});
});
function render(view, params = {}) {
  if (!S.deck && view !== 'settings') view = 'setup';
  (routes[view] || home)(params);
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- views
async function setup() {
  $app.innerHTML = `
    <div class="bar"><h1>Afrikaans</h1></div>
    <div class="panel stack">
      <h2>Welcome</h2>
      <p>This app studies the notes in your <b>afrikaans-vault</b> repository. To connect it, add a GitHub
      token in Settings (read access to that repo is enough for now).</p>
      <button class="btn primary block" id="to-settings">Open Settings</button>
    </div>`;
  document.getElementById('to-settings').onclick = () => go('settings');
}

async function home() {
  const now = new Date();
  const c = counts({ allCards: S.allCards, states: S.states, deck: S.deck, settings: S.settings, now });
  const logs = await logStore.since(new Date(dayStart(now) - 13 * 864e5).toISOString());
  const perDay = new Array(14).fill(0);
  const ds = dayStart(now).getTime();
  for (const l of logs) {
    const idx = 13 - Math.floor((ds - dayStart(new Date(l.ts)).getTime()) / 864e5);
    if (idx >= 0 && idx < 14) perDay[idx]++;
  }
  let streak = 0;
  for (let i = 13; i >= 0 && perDay[i] > 0; i--) streak++;
  const max = Math.max(1, ...perDay);
  const synced = await kv.get('deckSyncedAt');
  const lessons = S.deck.lessons;
  const latest = lessons[lessons.length - 1];

  $app.innerHTML = `
    <div class="bar">
      <h1>Afrikaans</h1>
      <button class="icon-btn" id="progress" aria-label="Progress">${ICON.chart}</button>
      <button class="icon-btn" id="sync" aria-label="Update deck">${ICON.sync}</button>
      <button class="icon-btn" id="settings" aria-label="Settings">${ICON.gear}</button>
    </div>
    <div class="stack">
      <div class="stats">
        <div class="stat"><b>${c.due}</b><span>due</span></div>
        <div class="stat"><b>${c.newToday}</b><span>new today</span></div>
        <div class="stat"><b>${perDay[13]}</b><span>done today</span></div>
      </div>
      <button class="btn primary block big" id="start" ${c.due + c.newToday ? '' : 'disabled'}>
        ${c.due + c.newToday ? 'Start review' : 'All done for today 🎉'}
      </button>
      <button class="btn block" id="practice">Practise a lesson or topic…</button>
      ${latest ? `<button class="btn block ghost" id="latest">Drill latest lesson (${esc(latest.date)})</button>` : ''}
      <div class="panel">
        <div class="row"><h2>Last 14 days</h2><span class="spacer"></span><span class="muted small">${streak ? `${streak}-day streak` : ''}</span></div>
        <div class="bars">${perDay.map(n => `<i class="${n ? '' : 'zero'}" style="height:${Math.max(4, (n / max) * 100)}%" title="${n}"></i>`).join('')}</div>
        <p class="muted small" style="margin-top:10px">${c.learned} cards started · ${c.newAvail} new waiting · ${Object.keys(S.deck.items).length} notes</p>
      </div>
      <p class="muted small center">Deck built ${esc((S.deck.built || '').slice(0, 16).replace('T', ' '))}${synced ? ` · checked ${esc(new Date(synced).toLocaleString())}` : ''}</p>
    </div>`;
  document.getElementById('start').onclick = () => startSession({ mode: 'daily' });
  document.getElementById('practice').onclick = () => go('practice');
  document.getElementById('settings').onclick = () => go('settings');
  document.getElementById('progress').onclick = () => go('progress');
  document.getElementById('sync').onclick = async () => { await syncDeck({ force: false }); await saveProgress(); home(); };
  const l = document.getElementById('latest');
  if (l) l.onclick = () => startSession({ mode: 'cram', size: 25, filter: makeFilter({ lesson: latest.id }), title: `Lesson ${latest.date}` });
}

// ---------------------------------------------------------------- practice (filters)
function makeFilter(f) {
  return (card, it) => {
    if (!it) return false;
    if (f.lesson && !(it.lessons || []).includes(f.lesson)) return false;
    if (f.topic && !(it.topics || []).includes(f.topic)) return false;
    if (f.grammar && !(it.t === 'p' && (it.grammar || []).includes(f.grammar))) return false;
    if (f.level && it.level !== f.level) return false;
    if (f.kind === 'v' && it.t !== 'v') return false;
    if (f.kind === 'p' && it.t !== 'p') return false;
    if (f.favourites && !it.fav) return false;
    return true;
  };
}

async function practice() {
  const items = Object.values(S.deck.items);
  const topics = [...new Set(items.flatMap(i => i.topics || []))].sort();
  const lessons = [...S.deck.lessons].reverse();
  const saved = (await kv.get('practiceFilter')) || {};
  $app.innerHTML = `
    <div class="bar">
      <button class="icon-btn" id="back" aria-label="Back">${ICON.back}</button>
      <h1>Practise</h1>
    </div>
    <form id="pf" class="stack">
      <div class="panel">
        <label class="field"><span>Lesson</span>
          <select name="lesson"><option value="">Any lesson</option>
            ${lessons.map(l => `<option value="${esc(l.id)}">${esc(l.date)}${l.topics.length ? ' — ' + esc(l.topics.slice(0, 3).join(', ')) : ''}</option>`).join('')}
          </select></label>
        <label class="field"><span>Topic</span>
          <select name="topic"><option value="">Any topic</option>${topics.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>
        <label class="field"><span>Grammar (sentences only)</span>
          <select name="grammar"><option value="">Any</option>${S.deck.grammar.map(g => `<option>${esc(g.id)}</option>`).join('')}</select></label>
        <div class="row">
          <label class="field" style="flex:1"><span>Level</span>
            <select name="level"><option value="">Any</option><option>A1</option><option>A2</option><option>B1</option></select></label>
          <label class="field" style="flex:1"><span>Notes</span>
            <select name="kind"><option value="">Words + sentences</option><option value="v">Words only</option><option value="p">Sentences only</option></select></label>
        </div>
        <label class="check"><input type="checkbox" name="favourites"> Favourites only</label>
      </div>
      <div class="panel">
        <div class="seg" role="radiogroup">
          <label><input type="radio" name="mode" value="cram" checked><span>Practise now</span></label>
          <label><input type="radio" name="mode" value="daily"><span>Only due + new</span></label>
        </div>
        <label class="field" style="margin-top:12px"><span>How many cards</span>
          <input type="number" name="size" min="5" max="200" value="${saved.size || 25}"></label>
        <p class="muted small" id="count"></p>
      </div>
      <button class="btn primary block big" type="submit">Start</button>
      <details class="panel">
        <summary>Already know these?</summary>
        <p class="small muted">Marks every <b>new</b> card in this selection as known, so they start with a long interval instead of being taught from scratch. Useful for older lessons.</p>
        <button class="btn block" type="button" id="known">Mark new cards as known</button>
      </details>
    </form>`;
  const form = document.getElementById('pf');
  for (const [k, v] of Object.entries(saved)) {
    const el = form.elements[k];
    if (!el || k === 'mode') continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  const read = () => {
    const fd = new FormData(form);
    return {
      lesson: fd.get('lesson'), topic: fd.get('topic'), grammar: fd.get('grammar'), level: fd.get('level'),
      kind: fd.get('kind'), favourites: fd.get('favourites') === 'on', mode: fd.get('mode'), size: +fd.get('size') || 25,
    };
  };
  const upd = () => {
    const f = read();
    const filt = makeFilter(f);
    const c = counts({ allCards: S.allCards, states: S.states, deck: S.deck, settings: S.settings, filter: filt });
    const total = S.allCards.filter(x => filt(x, S.deck.items[x.item])).length;
    document.getElementById('count').textContent = `${total} cards match · ${c.due} due · ${total - c.learned} never studied`;
  };
  form.onchange = upd; upd();
  form.onsubmit = async e => {
    e.preventDefault();
    const f = read();
    await kv.set('practiceFilter', f);
    const label = f.lesson ? `Lesson ${f.lesson}` : f.topic || f.grammar || 'Practice';
    startSession({ mode: f.mode, size: f.size, filter: makeFilter(f), title: label });
  };
  document.getElementById('back').onclick = () => history.back();
  const kb = document.getElementById('known');
  kb.onclick = async () => {
    if (kb.dataset.confirm !== '1') { kb.dataset.confirm = '1'; kb.textContent = 'Tap again to confirm'; kb.classList.add('danger'); return; }
    const filt = makeFilter(read());
    const list = S.allCards.filter(c => filt(c, S.deck.items[c.item]) && !S.states.has(c.id));
    const n = await markKnown(list, S.states);
    toast(`Marked ${n} cards as known`);
    kb.dataset.confirm = ''; kb.textContent = 'Mark new cards as known'; kb.classList.remove('danger');
    upd();
  };
}

// ---------------------------------------------------------------- study session
function startSession({ mode, size = 0, filter = null, title = 'Review' }) {
  const queue = buildQueue({ allCards: S.allCards, states: S.states, deck: S.deck, settings: S.settings, filter, mode, size });
  if (!queue.length) { toast('Nothing to study with those settings'); return; }
  S.session = new Session(queue, S.states, mode);
  S.session.title = title;
  // fetch audio for this session in the background
  if (navigator.onLine && S.settings.token) {
    gh.prefetchAudio(queue.map(c => S.deck.items[c.item].audio)).catch(() => {});
  }
  go('study');
}

async function study() {
  const sess = S.session;
  if (!sess) return go('home');
  const card = sess.next();
  if (!card) return finished();
  const it = S.deck.items[card.item];
  if (!it) return study();
  const st = S.states.get(card.id);
  const isNew = !st;
  const t0 = Date.now();

  let typing = card.type === 'cz' || (card.type === 'ra' && S.settings.typeProduction) || (card.type === 'ar' && S.settings.typeRecognition);
  let cz = null;
  if (card.type === 'cz') cz = it.cloze[Math.floor(Math.random() * it.cloze.length)];

  // ---- prompt
  let promptHtml = '', kind = TYPE_LABEL[card.type], sub = '';
  if (card.type === 'ar') {
    promptHtml = `<div class="prompt ${it.t === 'p' ? 'sentence' : ''}" lang="af">${esc(it.af)}</div>${audioBtn(it.audio)}`;
    sub = itemInfo(it);
  } else if (card.type === 'ra') {
    promptHtml = `<div class="prompt ${it.t === 'p' ? 'sentence' : ''}">${esc(it.en.join(' / '))}</div>`;
    sub = itemInfo(it);
  } else {
    const [a, b, w] = cz;
    const blank = it.af.slice(a, b);
    promptHtml = `<div class="prompt sentence" lang="af">${esc(it.af.slice(0, a))}<span class="gap" id="gap">${esc(blank)}</span>${esc(it.af.slice(b))}</div>`;
    const base = S.deck.items['v:' + w];
    sub = esc(it.en[0]) + (base && base.af.toLowerCase() !== blank.toLowerCase() ? ` · <b>(${esc(base.af)})</b>` : '');
  }

  const pct = sess.total ? Math.min(100, (sess.done / (sess.done + sess.remaining() + 1)) * 100) : 0;
  $app.innerHTML = `
    <div class="bar">
      <button class="icon-btn" id="quit" aria-label="End session">${ICON.close}</button>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <span class="muted small">${sess.remaining() + 1}</span>
    </div>
    <div class="study ${typing ? 'typing' : ''}">
      <div class="panel card-face">
        <div class="kind">${esc(kind)}${isNew ? ' · <span style="color:var(--accent)">new</span>' : ''}</div>
        ${promptHtml}
        ${sub ? `<div class="sub small">${sub}</div>` : ''}
        <div id="answer"></div>
      </div>
      <div class="footer-actions ${typing ? 'typing' : ''}" id="actions">
        ${typing
          ? `<form id="af" class="stack"><input class="answer-input" id="typed" autocomplete="off" autocapitalize="off" spellcheck="false"
               lang="${card.type === 'ar' ? 'en' : 'af'}" placeholder="${card.type === 'ar' ? 'Type the English…' : 'Tik in Afrikaans…'}">
               <div class="row"><button type="button" class="btn ghost" id="skip">Don't know</button><button class="btn primary" style="flex:1">Check</button></div></form>`
          : `<button class="btn primary block big" id="show">Show answer</button>`}
      </div>
    </div>`;
  wireAudio();
  document.getElementById('quit').onclick = () => finished(true);
  if (card.type === 'ar' && S.settings.autoplay && it.audio) play(it.audio, $app.querySelector('[data-audio]'));

  const reveal = (typedText = null) => {
    let result = null;
    if (typedText !== null) {
      const accepted = card.type === 'ar' ? englishVariants(it.en)
        : card.type === 'cz' ? [it.af.slice(cz[0], cz[1])]
        : (it.t === 'v' ? it.accept : [it.af]);
      result = check(typedText, accepted, { strictAccents: S.settings.strictAccents, english: card.type === 'ar' });
      if (card.type === 'ar' && result.verdict !== 'exact') {
        result.best = it.en.join(' / ');
      }
    }
    showAnswer(card, it, st, result, typedText, Date.now() - t0);
  };

  if (typing) {
    const inp = document.getElementById('typed');
    // keep the question visible when the keyboard opens
    inp.addEventListener('focus', () => setTimeout(() => window.scrollTo({ top: 0 }), 300));
    if (window.visualViewport) {
      const onVV = () => { if (document.activeElement === inp) window.scrollTo({ top: 0 }); };
      window.visualViewport.addEventListener('resize', onVV, { once: true });
    }
    setTimeout(() => inp.focus(), 50);
    document.getElementById('af').onsubmit = e => { e.preventDefault(); reveal(inp.value); };
    document.getElementById('skip').onclick = () => reveal('');
  } else {
    document.getElementById('show').onclick = () => reveal(null);
  }
}

function showAnswer(card, it, st, result, typedText, ms) {
  const gap = document.getElementById('gap');
  if (gap) gap.classList.add('filled');

  let verdictHtml = '';
  if (result) {
    const label = { exact: 'Correct!', accent: 'Correct — check the accents', close: 'Nearly!', wrong: typedText ? 'Not quite' : 'Answer' }[result.verdict];
    const showDiff = typedText && result.verdict !== 'exact' && card.type !== 'ar';
    verdictHtml = `<div class="verdict ${result.verdict}">${label}
      ${showDiff ? `<div class="diff" lang="af">${diffHtml(typedText, result.best)}</div>` : ''}
      ${typedText && card.type === 'ar' && result.verdict !== 'exact' ? `<div class="diff small">You wrote: ${esc(typedText)}</div>` : ''}</div>`;
  }

  const facts = [];
  if (it.t === 'v') {
    const f = it.forms || {};
    const lab = { plural: 'pl.', diminutive: 'dim.', attributive: 'attr.', comparative: 'comp.', superlative: 'sup.', past_participle: 'past', preterite: 'pret.' };
    for (const [k, l] of Object.entries(lab)) if (f[k]) facts.push(`${l} <b lang="af">${esc(f[k])}</b>`);
    if (it.construction) facts.push(esc(it.construction));
    if (it.register) facts.push(esc(it.register));
  } else {
    (it.grammar || []).forEach(g => facts.push(esc(g)));
    if (it.register) facts.push(esc(it.register));
  }
  if (it.lessons && it.lessons.length) facts.push('lesson ' + esc(it.lessons[it.lessons.length - 1]));

  const words = (it.t === 'p'
    ? `<div class="word-list">${it.words.map(w => S.deck.items['v:' + w]).filter(Boolean).map(v => `<div><b lang="af">${esc(v.af)}</b> — ${esc(v.en.join(', '))}</div>`).join('')}</div>` : '');

  document.getElementById('answer').innerHTML = `
    <div class="answer">
      ${verdictHtml}
      ${card.type === 'ar' ? '' : `<div class="af" lang="af" style="margin-top:10px">${esc(it.af)}</div>${audioBtn(it.audio)}`}
      <div class="en">${esc(it.en.join(' / '))}</div>
      ${facts.length ? `<div class="facts">${facts.map(f => `<span class="chip">${f}</span>`).join('')}</div>` : ''}
      ${words}
      ${it.note ? `<div class="note">${md(it.note)}</div>` : ''}
    </div>`;
  wireAudio(document.getElementById('answer'));
  if (card.type !== 'ar' && S.settings.autoplay && it.audio) play(it.audio, document.querySelector('#answer [data-audio]'));

  const pv = preview(st);
  const sugg = result ? result.suggested : 0;
  const names = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
  document.getElementById('actions').classList.remove('typing');
  document.querySelector('.study')?.classList.remove('typing');
  document.getElementById('actions').innerHTML = `
    <div class="ratings">
      ${[1, 2, 3, 4].map(r => `<button class="rate r${r} ${sugg === r ? 'suggested' : ''}" data-r="${r}">${names[r]}<small>${fmtInterval(pv[r])}</small></button>`).join('')}
    </div>`;
  document.querySelectorAll('.rate').forEach(b => b.onclick = async () => {
    document.querySelectorAll('.rate').forEach(x => x.disabled = true);
    await S.session.rate(card, +b.dataset.r, { typed: typedText, verdict: result?.verdict || null, ms });
    study();
  });
  document.activeElement && document.activeElement.blur();
}

function finished(early = false) {
  const sess = S.session;
  S.session = null;
  history.replaceState({ view: 'home', params: {} }, '', '#home');
  if (!sess || !sess.done) return render('home');
  saveProgress({ quiet: true }).then(ok => {
    const el = document.getElementById('saved'); if (el) el.textContent = ok ? 'Progress saved to your vault ✓' : 'Progress kept on this phone — will save to the vault when online.';
  });
  $app.innerHTML = `
    <div class="bar"><h1>${early ? 'Session ended' : 'Klaar!'}</h1></div>
    <div class="panel done">
      <b>${sess.done}</b>
      <p>cards reviewed${early ? '' : ' — baie goed!'}</p>
      <p class="small muted" id="saved">Saving progress…</p>
    </div>
    <div class="stack" style="margin-top:12px">
      <button class="btn primary block big" id="home">Back to home</button>
      <button class="btn block" id="prog">See progress</button>
    </div>`;
  document.getElementById('home').onclick = () => render('home');
  document.getElementById('prog').onclick = () => go('progress');
}

// ---------------------------------------------------------------- progress
function wireTips(root) {
  root.querySelectorAll('.chart').forEach(ch => {
    const cap = ch.querySelector('.tip');
    const show = el => { const t = el.closest('[data-tip]'); if (t && cap) cap.textContent = t.dataset.tip; };
    ch.addEventListener('pointerover', e => show(e.target));
    ch.addEventListener('click', e => show(e.target));
  });
}
const pctOf = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function meter(started, mature, total) {
  const s = pctOf(started - mature, total), m = pctOf(mature, total);
  return `<div class="meter" role="img" aria-label="${m}% mature, ${pctOf(started, total)}% started">
    ${m ? `<i class="m" style="width:${m}%"></i>` : ''}${s ? `<i class="s" style="width:${s}%"></i>` : ''}</div>`;
}

async function progressView() {
  const logs = await logStore.all();
  const st = computeStats({ deck: S.deck, cards: S.allCards, states: S.states, logs });
  const P = APP_PALETTE;
  const lessons = [...st.lessons].reverse().filter(l => l.total);
  const grammar = [...st.grammar].sort((a, b) => b.mature / b.total - a.mature / a.total || b.started / b.total - a.started / a.total);
  const at = await kv.get('progressSyncedAt');
  $app.innerHTML = `
    <div class="bar">
      <button class="icon-btn" id="back" aria-label="Back">${ICON.back}</button>
      <h1>Progress</h1>
    </div>
    <div class="stack">
      <div class="hero panel">
        <span class="muted small">Words learned</span>
        <b>${st.words.learned.toLocaleString()}</b>
        <span class="muted small">of ${st.words.total.toLocaleString()} · ${st.words.mastered.toLocaleString()} mastered</span>
      </div>
      <div class="stats">
        <div class="stat"><b>${st.sentences.learned.toLocaleString()}</b><span>sentences learned</span></div>
        <div class="stat"><b>${st.streak}</b><span>day streak</span></div>
        <div class="stat"><b>${st.recall30 == null ? '—' : Math.round(st.recall30 * 100) + '%'}</b><span>recall, 30 days</span></div>
      </div>

      <div class="panel chart">
        <h2>Activity</h2>
        <p class="muted small">Reviews per day, last 20 weeks · ${st.reviews30.toLocaleString()} in the last 30 days · ${st.minutes7} min this week</p>
        ${heatmapSvg(st.heat, P)}
        <p class="tip small">Tap a day for details</p>
      </div>

      <div class="panel chart">
        <h2>Cards by stage</h2>
        <p class="muted small">Young = interval under 21 days · Mature = 21 days or more</p>
        ${stagesSvg(st.stages, P)}
        <p class="tip small"></p>
      </div>

      <div class="panel chart">
        <h2>Coming up</h2>
        <p class="muted small">Cards due each day for the next two weeks</p>
        ${forecastSvg(st.forecast, P)}
        <p class="tip small">Tap a day for details</p>
      </div>

      <div class="panel">
        <div class="row"><h2>Trickiest</h2><span class="spacer"></span>
          ${st.trickiest.length ? '<button class="btn" id="tricky">Practise these</button>' : ''}</div>
        ${st.trickiest.length ? `<div class="list">${st.trickiest.slice(0, 12).map(t => {
          const it = S.deck.items[t.item];
          return `<div class="li"><div class="grow"><b lang="af">${esc(it.af)}</b><div class="muted small">${esc(it.en.join(' / '))}</div></div><span class="muted small" style="white-space:nowrap">${t.lapses ? `forgot ${t.lapses}×` : `missed ${t.again30}×`}</span></div>`;
        }).join('')}</div>` : '<p class="muted small">Nothing tricky yet — words you keep forgetting will show up here.</p>'}
      </div>

      <div class="panel">
        <h2>By lesson</h2>
        <div class="legend small"><span><i class="sw m"></i>Mature</span><span><i class="sw s"></i>Started</span><span class="spacer"></span><span>% started</span></div>
        <div class="list">${lessons.map(l => `
          <button class="li lesson" data-lesson="${esc(l.id)}">
            <div class="grow"><div class="row"><b>${esc(l.date)}</b><span class="muted small ellipsis">${esc(l.topics.slice(0, 3).join(', '))}</span></div>
            ${meter(l.started, l.mature, l.total)}</div>
            <span class="muted small num" title="started">${pctOf(l.started, l.total)}%</span>
          </button>`).join('')}</div>
        <p class="muted small">Tap a lesson to practise it.</p>
      </div>

      <div class="panel">
        <h2>Grammar</h2>
        <div class="list">${grammar.map(g => `
          <div class="li"><div class="grow"><div class="row"><b>${esc(g.id)}</b><span class="spacer"></span><span class="muted small">${g.total} cards</span></div>
          ${meter(g.started, g.mature, g.total)}</div><span class="muted small num" title="started">${pctOf(g.started, g.total)}%</span></div>`).join('')}</div>
      </div>
      <p class="muted small center">${at ? `Saved to vault ${esc(new Date(at).toLocaleString())} · also in Obsidian under <b>Progress</b>` : 'Not yet saved to the vault'}</p>
    </div>`;
  wireTips($app);
  document.getElementById('back').onclick = () => history.back();
  $app.querySelectorAll('[data-lesson]').forEach(b => b.onclick = () => {
    const id = b.dataset.lesson;
    startSession({ mode: 'cram', size: 25, filter: makeFilter({ lesson: id }), title: `Lesson ${id}` });
  });
  const tb = document.getElementById('tricky');
  if (tb) tb.onclick = () => {
    const set = new Set(st.trickiest.map(t => t.item));
    startSession({ mode: 'cram', size: 25, filter: (c, it) => set.has(c.item) && !!S.states.get(c.id), title: 'Trickiest' });
  };
}

// ---------------------------------------------------------------- settings
async function settingsView() {
  const s = S.settings;
  const nAudio = await gh.audioCount();
  const totalAudio = S.deck ? new Set(Object.values(S.deck.items).map(i => i.audio).filter(Boolean)).size : 0;
  $app.innerHTML = `
    <div class="bar">
      <button class="icon-btn" id="back" aria-label="Back">${ICON.back}</button>
      <h1>Settings</h1>
    </div>
    <form id="sf" class="stack">
      <div class="panel">
        <h2>GitHub connection</h2>
        <label class="field" style="margin-top:12px"><span>Owner</span><input type="text" name="owner" value="${esc(s.owner)}" autocapitalize="off"></label>
        <label class="field"><span>Vault repository</span><input type="text" name="repo" value="${esc(s.repo)}" autocapitalize="off"></label>
        <label class="field"><span>Token (fine-grained, this repo only)</span><input type="password" name="token" value="${esc(s.token)}" autocomplete="off" placeholder="github_pat_…"></label>
        <button type="button" class="btn primary block" id="connect">Save &amp; download deck</button>
      </div>
      <div class="panel">
        <h2>Studying</h2>
        <label class="field" style="margin-top:12px"><span>New cards per day</span><input type="number" name="newPerDay" min="0" max="100" value="${s.newPerDay}"></label>
        <label class="field"><span>New cards come from</span>
          <select name="newOrder">
            <option value="newest" ${s.newOrder === 'newest' ? 'selected' : ''}>Newest lessons first</option>
            <option value="oldest" ${s.newOrder === 'oldest' ? 'selected' : ''}>Oldest lessons first</option>
            <option value="random" ${s.newOrder === 'random' ? 'selected' : ''}>Random</option>
          </select></label>
        <label class="field"><span>Target recall (higher = more reviews)</span>
          <select name="retention">
            ${[0.85, 0.9, 0.93, 0.95].map(r => `<option value="${r}" ${s.retention == r ? 'selected' : ''}>${Math.round(r * 100)}%</option>`).join('')}
          </select></label>
        <p class="small muted" style="margin:12px 0 4px">Card types</p>
        <label class="check"><input type="checkbox" name="ct_ar" ${s.cardTypes.ar ? 'checked' : ''}> Afrikaans → English (meaning)</label>
        <label class="check"><input type="checkbox" name="ct_ra" ${s.cardTypes.ra ? 'checked' : ''}> English → Afrikaans (say it)</label>
        <label class="check"><input type="checkbox" name="ct_cz" ${s.cardTypes.cz ? 'checked' : ''}> Fill the gap in a sentence</label>
        <p class="small muted" style="margin:12px 0 4px">Answers</p>
        <label class="check"><input type="checkbox" name="typeProduction" ${s.typeProduction ? 'checked' : ''}> Type the Afrikaans answer</label>
        <label class="check"><input type="checkbox" name="typeRecognition" ${s.typeRecognition ? 'checked' : ''}> Type the English answer too</label>
        <label class="check"><input type="checkbox" name="strictAccents" ${s.strictAccents ? 'checked' : ''}> Strict accents (ê, ë, ô count)</label>
        <label class="check"><input type="checkbox" name="autoplay" ${s.autoplay ? 'checked' : ''}> Play audio automatically</label>
      </div>
      <div class="panel stack">
        <h2>Offline audio</h2>
        <p class="small muted" id="audio-stat">${nAudio} of ${totalAudio} clips saved on this phone.</p>
        <button type="button" class="btn block" id="dl-audio">Download all audio</button>
      </div>
      <div class="panel stack">
        <h2>Progress backup</h2>
        <p class="small muted" id="sync-stat">Progress is saved to your vault (<code>_app/progress</code>) after each session, and the Obsidian dashboards in <code>Progress/</code> are updated.</p>
        <button type="button" class="btn block" id="save-now">Save progress now</button>
        <p class="small muted">Or keep a file copy:</p>
        <div class="row"><button type="button" class="btn" id="export" style="flex:1">Export</button>
        <label class="btn" style="flex:1">Import<input type="file" id="import" accept="application/json" hidden></label></div>
      </div>
      <p class="small muted center">Deck: ${S.deck ? `${Object.keys(S.deck.items).length} notes, built ${esc(S.deck.built)}` : 'not downloaded'}</p>
    </form>`;
  const form = document.getElementById('sf');
  const readForm = () => {
    const fd = new FormData(form);
    return {
      owner: fd.get('owner').trim(), repo: fd.get('repo').trim(), token: fd.get('token').trim(),
      newPerDay: Math.max(0, +fd.get('newPerDay') || 0), newOrder: fd.get('newOrder'), retention: +fd.get('retention'),
      cardTypes: { ar: fd.get('ct_ar') === 'on', ra: fd.get('ct_ra') === 'on', cz: fd.get('ct_cz') === 'on' },
      typeProduction: fd.get('typeProduction') === 'on', typeRecognition: fd.get('typeRecognition') === 'on',
      strictAccents: fd.get('strictAccents') === 'on', autoplay: fd.get('autoplay') === 'on',
    };
  };
  form.onchange = () => saveSettings(readForm());
  document.getElementById('back').onclick = () => (S.deck ? history.back() : render('setup'));
  document.getElementById('connect').onclick = async () => {
    await saveSettings(readForm());
    const ok = await syncDeck({ force: true });
    if (ok) { await saveProgress({ quiet: true }); go('home'); }
  };
  document.getElementById('dl-audio').onclick = async e => {
    const btn = e.currentTarget; btn.disabled = true;
    const stat = document.getElementById('audio-stat');
    try {
      const keys = Object.values(S.deck.items).map(i => i.audio).filter(Boolean);
      const r = await gh.prefetchAudio(keys, (d, t) => { stat.textContent = `Downloading… ${d} / ${t}`; });
      stat.textContent = `Done. ${await gh.audioCount()} clips saved${r.failed ? ` (${r.failed} failed — try again)` : ''}.`;
    } catch (err) { stat.textContent = err.message; }
    btn.disabled = false;
  };
  kv.get('progressSyncedAt').then(at => {
    if (at) document.getElementById('sync-stat').insertAdjacentHTML('beforeend', ` Last saved ${esc(new Date(at).toLocaleString())}.`);
  });
  document.getElementById('save-now').onclick = async e => {
    e.currentTarget.disabled = true;
    const ok = await saveProgress();
    e.currentTarget.disabled = false;
    if (ok) settingsView();
  };
  document.getElementById('export').onclick = async () => {
    const data = { app: 'afrikaans', version: 1, exported: new Date().toISOString(),
      cards: await cardStore.all(), log: await logStore.all(), settings: { ...S.settings, token: '' } };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = `afrikaans-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  document.getElementById('import').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'afrikaans') throw new Error('Not an Afrikaans backup file');
      await cardStore.clear(); await cardStore.putMany(data.cards || []);
      await logStore.clear(); await logStore.addMany((data.log || []));
      S.states = await loadStates();
      toast(`Restored ${data.cards.length} cards`);
    } catch (err) { toast(err.message, 4000); }
  };
}

// ---------------------------------------------------------------- boot
document.addEventListener('keydown', e => {
  if (!S.session) return;
  if (e.target.tagName === 'INPUT') return;
  if (['1', '2', '3', '4'].includes(e.key)) document.querySelector(`.rate[data-r="${e.key}"]`)?.click();
  if (e.key === ' ' || e.key === 'Enter') { const b = document.getElementById('show'); if (b) { e.preventDefault(); b.click(); } }
});

(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await loadAll();
  history.replaceState({ view: 'home', params: {} }, '', '#home');
  render(S.deck ? 'home' : 'setup');
  if (S.deck && S.settings.token) {
    const ok = await syncDeck({ quiet: true });
    if (ok && (S.states.size === 0 || (await progressDirty()))) await saveProgress({ quiet: true });
    if (ok && !S.session && location.hash === '#home') home();
  }
})();
