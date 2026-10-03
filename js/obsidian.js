// Builds the Obsidian progress dashboards (markdown + SVG) from computed stats.
import { heatmapSvg, forecastSvg, stagesSvg, OBSIDIAN_PALETTE as P } from './charts.js';

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const bar = (p, n = 10) => '▰'.repeat(Math.round((p / 100) * n)) + '▱'.repeat(n - Math.round((p / 100) * n));
const cellSafe = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const NOTICE = '> [!info] Written by the Afrikaans app after each study session. Don\'t edit — it gets overwritten.';

export function dashboardFiles(stats, deck) {
  const s = stats;
  const updated = s.built.slice(0, 16).replace('T', ' ');
  const files = {};

  files['Progress/charts/activity.svg'] = heatmapSvg(s.heat, P);
  files['Progress/charts/forecast.svg'] = forecastSvg(s.forecast, P);
  files['Progress/charts/stages.svg'] = stagesSvg(s.stages, P);

  const last7 = s.heat.slice(-7).reverse();
  const grammar = [...s.grammar].sort((a, b) => pct(b.mature, b.total) - pct(a.mature, a.total) || pct(b.started, b.total) - pct(a.started, a.total));
  files['Progress/Dashboard.md'] = `---
updated: ${s.built}
words_learned: ${s.words.learned}
words_mastered: ${s.words.mastered}
sentences_learned: ${s.sentences.learned}
streak: ${s.streak}
recall_30d: ${s.recall30 == null ? '' : Math.round(s.recall30 * 100)}
---
${NOTICE}

# Afrikaans progress

*Updated ${updated}* · [[Progress/Lessons|By lesson]] · [[Progress/Trickiest words|Trickiest words]]

| | |
|---|---|
| **Words learned** | ${s.words.learned.toLocaleString()} of ${s.words.total.toLocaleString()} (${s.words.mastered.toLocaleString()} mastered) |
| **Sentences learned** | ${s.sentences.learned.toLocaleString()} of ${s.sentences.total.toLocaleString()} (${s.sentences.mastered.toLocaleString()} mastered) |
| **Streak** | ${s.streak} day${s.streak === 1 ? '' : 's'} |
| **Reviews, last 30 days** | ${s.reviews30.toLocaleString()} |
| **Recall, last 30 days** | ${s.recall30 == null ? '—' : Math.round(s.recall30 * 100) + '%'} ${s.recallN ? `(of ${s.recallN} reviews of known cards)` : ''} |
| **Study time, last 7 days** | ${s.minutes7} min |

## Activity
Reviews per day, last 20 weeks. Darker = more.

![[Progress/charts/activity.svg]]

| Day | Reviews |
|---|---:|
${last7.map(d => `| ${d.date} | ${d.n} |`).join('\n')}

## Cards by stage
*Learning* = still in short steps · *Young* = interval under 21 days · *Mature* = 21 days or more.

![[Progress/charts/stages.svg]]

| Card type | Not started | Learning | Young | Mature |
|---|---:|---:|---:|---:|
${[['Meaning (af → en)', 'ar'], ['Say it (en → af)', 'ra'], ['Fill the gap', 'cz']].map(([l, k]) => {
    const b = s.byType[k]; return `| ${l} | ${b.new} | ${b.learning} | ${b.young} | ${b.mature} |`;
  }).join('\n')}

## Coming up
Cards due each day for the next two weeks (today includes anything overdue).

![[Progress/charts/forecast.svg]]

## Grammar
Cards from sentences tagged with each grammar topic.

| Topic | Cards | Started | Mature | |
|---|---:|---:|---:|---|
${grammar.map(g => `| [[${g.id}]] | ${g.total} | ${pct(g.started, g.total)}% | ${pct(g.mature, g.total)}% | ${bar(pct(g.mature, g.total))} |`).join('\n')}
`;

  const lessons = [...s.lessons].reverse();
  files['Progress/Lessons.md'] = `---
updated: ${s.built}
---
${NOTICE}

# Progress by lesson

*Updated ${updated}* · [[Progress/Dashboard|Dashboard]]

Started = cards you've seen at least once · Mature = cards with an interval of 21+ days.

| Lesson | Topics | Cards | Started | Mature | |
|---|---|---:|---:|---:|---|
${lessons.filter(l => l.total).map(l => `| [[${l.id}]] | ${cellSafe(l.topics.slice(0, 3).join(', '))} | ${l.total} | ${pct(l.started, l.total)}% | ${pct(l.mature, l.total)}% | ${bar(pct(l.mature, l.total))} |`).join('\n')}
`;

  files['Progress/Trickiest words.md'] = `---
updated: ${s.built}
---
${NOTICE}

# Trickiest words & sentences

*Updated ${updated}* · [[Progress/Dashboard|Dashboard]]

Ranked by how often you've forgotten them (lapses) and missed them in the last 30 days. In the app: **Progress → Practise these**.

${s.trickiest.length ? `| Note | Meaning | Lapses | Misses (30 d) |
|---|---|---:|---:|
${s.trickiest.map(t => { const it = deck.items[t.item]; return `| [[${it.name}]] | ${cellSafe(it.en.join(' / '))} | ${t.lapses} | ${t.again30} |`; }).join('\n')}` : '*Nothing tricky yet — keep reviewing and this list will fill up.*'}
`;
  return files;
}
