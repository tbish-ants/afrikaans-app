// Progress statistics — shared by the in-app Progress screen and the Obsidian dashboards.
import { State } from '../vendor/ts-fsrs.mjs';
import { dayStart } from './sched.js';

export const MATURE_DAYS = 21;
const DAY = 864e5;

/** 'new' | 'learning' | 'young' | 'mature' */
export function stage(st) {
  if (!st) return 'new';
  const f = st.fsrs;
  if (f.state === State.New) return 'new';
  if (f.state === State.Learning || f.state === State.Relearning) return 'learning';
  return (f.scheduled_days || 0) >= MATURE_DAYS ? 'mature' : 'young';
}

const dayKey = d => { const x = dayStart(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

/**
 * @param deck   deck.json
 * @param cards  card definitions (buildCards)
 * @param states Map id -> state
 * @param logs   review log entries [{ts,id,rating,prevState,verdict,ms,mode}]
 */
export function computeStats({ deck, cards, states, logs, now = new Date(), heatDays = 140, forecastDays = 14 }) {
  const items = deck.items;
  const today = dayStart(now);

  // ---- card stages, overall and per type
  const stages = { new: 0, learning: 0, young: 0, mature: 0 };
  const byType = { ar: { ...stages }, ra: { ...stages }, cz: { ...stages } };
  const itemCards = new Map();          // item -> [stage...]
  for (const c of cards) {
    const s = stage(states.get(c.id));
    stages[s]++; byType[c.type][s]++;
    if (!itemCards.has(c.item)) itemCards.set(c.item, []);
    itemCards.get(c.item).push(s);
  }

  // item level: learned = any card past learning; mastered = every started card mature & meaning card mature
  let wordsTotal = 0, wordsLearned = 0, wordsMastered = 0, sentTotal = 0, sentLearned = 0, sentMastered = 0;
  for (const [iid, it] of Object.entries(items)) {
    const ss = itemCards.get(iid) || [];
    const learned = ss.some(s => s === 'young' || s === 'mature');
    const mastered = ss.length && ss.every(s => s === 'mature');
    if (it.t === 'v') { wordsTotal++; wordsLearned += learned; wordsMastered += mastered; }
    else { sentTotal++; sentLearned += learned; sentMastered += mastered; }
  }

  // ---- activity
  const perDay = new Map();
  let reviews30 = 0, recallN = 0, recallOk = 0, ms7 = 0;
  for (const l of logs) {
    const t = new Date(l.ts);
    const k = dayKey(t);
    perDay.set(k, (perDay.get(k) || 0) + 1);
    const age = now - t;
    if (age < 30 * DAY) {
      reviews30++;
      if (l.prevState === State.Review) { recallN++; if (l.rating > 1) recallOk++; }
    }
    if (age < 7 * DAY) ms7 += Math.min(l.ms || 0, 120000);
  }
  const heat = [];
  for (let i = heatDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * DAY + 12 * 3600e3);
    heat.push({ date: dayKey(d), n: perDay.get(dayKey(d)) || 0, dow: (d.getDay() + 6) % 7 });
  }
  let streak = 0;
  for (let i = heat.length - 1; i >= 0; i--) {
    if (heat[i].n > 0) streak++;
    else if (i === heat.length - 1) continue;   // today not done yet doesn't break the streak
    else break;
  }
  const todayN = perDay.get(dayKey(now)) || 0;

  // ---- forecast (overdue counts as today)
  const forecast = Array.from({ length: forecastDays }, (_, i) => ({ date: dayKey(new Date(today.getTime() + i * DAY + 12 * 3600e3)), n: 0 }));
  for (const st of states.values()) {
    if (!st.fsrs || st.fsrs.state === State.New) continue;
    const idx = Math.max(0, Math.floor((st.fsrs.due - today) / DAY));
    if (idx < forecastDays) forecast[idx].n++;
  }

  // ---- lessons & grammar
  const lessonRows = deck.lessons.map(l => ({ id: l.id, date: l.date, topics: l.topics, total: 0, started: 0, mature: 0 }));
  const lessonIdx = new Map(lessonRows.map(r => [r.id, r]));
  const grammarRows = deck.grammar.map(g => ({ id: g.id, total: 0, started: 0, mature: 0 }));
  const grammarIdx = new Map(grammarRows.map(r => [r.id, r]));
  for (const c of cards) {
    const it = items[c.item]; const s = stage(states.get(c.id));
    const add = r => { if (!r) return; r.total++; if (s !== 'new') r.started++; if (s === 'mature') r.mature++; };
    (it.lessons || []).forEach(l => add(lessonIdx.get(l)));
    if (it.t === 'p') (it.grammar || []).forEach(g => add(grammarIdx.get(g)));
  }

  // ---- topics (as tagged on words; sentences inherit their lesson's topics)
  const topicIdx = new Map();
  for (const c of cards) {
    const it = items[c.item]; const s = stage(states.get(c.id));
    for (const t of it.topics || []) {
      if (!topicIdx.has(t)) topicIdx.set(t, { id: t, total: 0, started: 0, mature: 0 });
      const r = topicIdx.get(t); r.total++; if (s !== 'new') r.started++; if (s === 'mature') r.mature++;
    }
  }
  const topics = [...topicIdx.values()].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));

  // ---- trickiest: lapses + recent misses
  const recentAgain = new Map();
  for (const l of logs) {
    if (now - new Date(l.ts) < 30 * DAY && l.rating === 1 && l.prevState !== State.New) {
      const iid = l.id.split('|')[0];
      recentAgain.set(iid, (recentAgain.get(iid) || 0) + 1);
    }
  }
  const tricky = new Map();
  for (const st of states.values()) {
    if (!st.fsrs) continue;
    const iid = st.id.split('|')[0];
    if (!items[iid]) continue;
    const t = tricky.get(iid) || { item: iid, lapses: 0, again30: recentAgain.get(iid) || 0, difficulty: 0 };
    t.lapses += st.fsrs.lapses || 0;
    t.difficulty = Math.max(t.difficulty, st.fsrs.difficulty || 0);
    tricky.set(iid, t);
  }
  const trickiest = [...tricky.values()]
    .map(t => ({ ...t, score: t.lapses * 2 + t.again30 * 3 + (t.difficulty > 8 ? 1 : 0) }))
    .filter(t => t.score >= 3)
    .sort((a, b) => b.score - a.score || b.difficulty - a.difficulty)
    .slice(0, 40);

  return {
    built: now.toISOString(),
    stages, byType,
    words: { total: wordsTotal, learned: wordsLearned, mastered: wordsMastered },
    sentences: { total: sentTotal, learned: sentLearned, mastered: sentMastered },
    reviews30, recall30: recallN ? recallOk / recallN : null, recallN,
    minutes7: Math.round(ms7 / 60000), streak, todayN, totalReviews: logs.length,
    heat, forecast,
    lessons: lessonRows, grammar: grammarRows.filter(r => r.total), topics,
    trickiest,
  };
}
