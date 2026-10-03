// SVG charts as strings, used both in the app (themed via CSS variables)
// and in the Obsidian dashboards (fixed colours that read on light and dark themes).

export const APP_PALETTE = {
  zero: 'var(--seq-0)', seq: ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)'],
  learning: 'var(--stage-learning)', young: 'var(--stage-young)', mature: 'var(--stage-mature)',
  track: 'var(--seq-0)', bar: 'var(--stage-young)', ink: 'var(--text)', muted: 'var(--muted)', grid: 'var(--line)',
  surface: 'var(--surface)',
};
// Obsidian: one green at increasing opacity reads as "more" on both light and dark themes.
const G = '#2a8f62';
export const OBSIDIAN_PALETTE = {
  zero: 'rgba(128,128,128,0.16)', seq: [G + '4d', G + '80', G + 'b3', G],
  learning: G + '59', young: G + 'a6', mature: G,
  track: 'rgba(128,128,128,0.16)', bar: G, ink: '#8a8f8c', muted: '#8a8f8c', grid: 'rgba(128,128,128,0.35)',
  surface: 'none',
};

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FONT = 'font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const fmtDate = key => { const [y, m, d] = key.split('-').map(Number); const dt = new Date(y, m - 1, d); return `${DOW[(dt.getDay() + 6) % 7]} ${d} ${MONTHS[m - 1]}`; };

/** Rounded-top bar path: square at the baseline, 4px radius at the data end. */
function colPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Calendar heatmap of reviews per day (columns = weeks, rows = Mon..Sun). */
export function heatmapSvg(heat, P) {
  const cell = 13, gap = 3, left = 28, top = 18;
  // align first column to Monday
  const pad = heat.length ? heat[0].dow : 0;
  const cells = [...Array(pad).fill(null), ...heat];
  const weeks = Math.ceil(cells.length / 7);
  const W = left + weeks * (cell + gap), H = top + 7 * (cell + gap);
  const max = Math.max(1, ...heat.map(h => h.n));
  const level = n => (n === 0 ? -1 : Math.min(3, Math.floor((n / max) * 4 - 1e-9)));
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Reviews per day" ${FONT}>`;
  let lastMonth = -1;
  cells.forEach((h, i) => {
    const col = Math.floor(i / 7), row = i % 7;
    if (!h) return;
    const x = left + col * (cell + gap), y = top + row * (cell + gap);
    const m = +h.date.slice(5, 7) - 1;
    if (row === 0 || i === pad) {
      if (m !== lastMonth && row === 0) { out += `<text x="${x}" y="11" font-size="10" fill="${P.muted}">${MONTHS[m]}</text>`; lastMonth = m; }
    }
    const lv = level(h.n);
    const tip = `${fmtDate(h.date)} · ${h.n} review${h.n === 1 ? '' : 's'}`;
    out += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${lv < 0 ? P.zero : P.seq[lv]}" data-tip="${esc(tip)}" tabindex="-1"><title>${esc(tip)}</title></rect>`;
  });
  ['Mon', '', 'Wed', '', 'Fri', '', ''].forEach((d, r) => {
    if (d) out += `<text x="0" y="${top + r * (cell + gap) + cell - 2}" font-size="10" fill="${P.muted}">${d}</text>`;
  });
  return out + '</svg>';
}

/** Column chart of cards due over the coming days. */
export function forecastSvg(forecast, P) {
  const W = 340, H = 140, left = 4, right = 4, top = 18, bottom = 22;
  const n = forecast.length, slot = (W - left - right) / n, bw = Math.min(16, slot - 4);
  const max = Math.max(1, ...forecast.map(f => f.n));
  const ph = H - top - bottom;
  const maxIdx = forecast.findIndex(f => f.n === max);
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Cards due per day, next ${n} days" ${FONT}>`;
  out += `<line x1="${left}" x2="${W - right}" y1="${top + ph + .5}" y2="${top + ph + .5}" stroke="${P.grid}" stroke-width="1"/>`;
  forecast.forEach((f, i) => {
    const x = left + i * slot + (slot - bw) / 2;
    const h = (f.n / max) * ph;
    const tip = `${i === 0 ? 'Today (incl. overdue)' : fmtDate(f.date)} · ${f.n} due`;
    out += `<g data-tip="${esc(tip)}"><title>${esc(tip)}</title><rect x="${left + i * slot}" y="${top}" width="${slot}" height="${ph}" fill="transparent"/>`;
    if (f.n) out += `<path d="${colPath(x, top + ph - h, bw, h)}" fill="${P.bar}"/>`;
    out += '</g>';
    if ((i === 0 || i === maxIdx) && f.n) {
      out += `<text x="${x + bw / 2}" y="${top + ph - h - 5}" font-size="10" text-anchor="middle" fill="${P.ink}">${f.n}</text>`;
    }
    if (i === 0 || i === 7 || i === n - 1) {
      const lab = i === 0 ? 'Today' : fmtDate(f.date).split(' ').slice(0, 2).join(' ');
      out += `<text x="${x + bw / 2}" y="${H - 6}" font-size="10" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" fill="${P.muted}">${lab}</text>`;
    }
  });
  return out + '</svg>';
}

/** One stacked bar of card stages (mature → young → learning → not started), with legend. */
export function stagesSvg(stages, P) {
  const W = 340, barY = 4, barH = 16, gap = 2;
  const segs = [
    ['Mature', stages.mature, P.mature], ['Young', stages.young, P.young],
    ['Learning', stages.learning, P.learning], ['Not started', stages.new, P.track],
  ];
  const total = segs.reduce((a, s) => a + s[1], 0) || 1;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 70" width="100%" role="img" aria-label="Cards by stage" ${FONT}>`;
  let x = 0;
  const visible = segs.filter(s => s[1] > 0);
  visible.forEach((s, i) => {
    const w = (s[1] / total) * (W - gap * (visible.length - 1));
    const tip = `${s[0]} · ${s[1].toLocaleString()} cards (${Math.round((s[1] / total) * 100)}%)`;
    const rL = i === 0 ? 4 : 0, rR = i === visible.length - 1 ? 4 : 0;
    out += `<path d="M${x + rL},${barY}H${x + w - rR}${rR ? `Q${x + w},${barY} ${x + w},${barY + rR}V${barY + barH - rR}Q${x + w},${barY + barH} ${x + w - rR},${barY + barH}` : `V${barY + barH}`}H${x + rL}${rL ? `Q${x},${barY + barH} ${x},${barY + barH - rL}V${barY + rL}Q${x},${barY} ${x + rL},${barY}` : `V${barY}`}Z" fill="${s[2]}" data-tip="${esc(tip)}"><title>${esc(tip)}</title></path>`;
    x += w + gap;
  });
  // legend: two per row
  segs.forEach((s, i) => {
    const lx = (i % 2) * 170, ly = 34 + Math.floor(i / 2) * 18;
    out += `<rect x="${lx}" y="${ly}" width="10" height="10" rx="2" fill="${s[2]}"/>`;
    out += `<text x="${lx + 15}" y="${ly + 9}" font-size="11" fill="${P.ink}">${esc(`${s[0]} · ${s[1].toLocaleString()}`)}</text>`;
  });
  return out + '</svg>';
}
