// Lenient answer checking + a small diff for feedback.

const stripMarks = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');

export function norm(s, { accents = true } = {}) {
  let t = (s || '').normalize('NFC').toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[–—]/g, '-');
  if (!accents) t = stripMarks(t);
  t = t.replace(/[^\p{L}\p{N}' -]+/gu, ' ')   // drop punctuation, keep apostrophes/hyphens
       .replace(/(^|\s)'(?!n\b)/g, '$1')       // stray leading apostrophes (but keep 'n)
       .replace(/\s+/g, ' ').trim()
       .replace(/(^| )'n(?= |$)/g, '$1n');      // 'n == n
  return t;
}

/** English answers: split "a, b / c", drop "(…)" asides, leading "to ", articles. */
export function englishVariants(list) {
  const out = new Set();
  for (const raw of list || []) {
    for (const part of String(raw).split(/[,;/]| or /)) {
      let p = part.replace(/\([^)]*\)/g, ' ');
      p = norm(p);
      if (!p) continue;
      out.add(p);
      out.add(p.replace(/^(to|the|a|an) /, ''));
    }
    const whole = norm(String(raw).replace(/\([^)]*\)/g, ' '));
    if (whole) out.add(whole);
  }
  return [...out].filter(Boolean);
}

export function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Compare a typed answer with the accepted answers.
 * Returns {verdict: 'exact'|'accent'|'close'|'wrong', best, suggested: 1..4}
 */
export function check(typed, accepted, { strictAccents = false, english = false } = {}) {
  if (english) typed = norm(typed).replace(/^(to|the|a|an) /, '');
  const t = norm(typed);
  if (!t) return { verdict: 'wrong', best: accepted[0], suggested: 1, empty: true };
  let best = accepted[0], bestD = Infinity;
  for (const a of accepted) {
    const na = norm(a);
    if (na === t) return { verdict: 'exact', best: a, suggested: 3 };
    if (norm(a, { accents: false }) === norm(typed, { accents: false })) {
      return strictAccents
        ? { verdict: 'close', best: a, suggested: 2, accentOnly: true }
        : { verdict: 'accent', best: a, suggested: 3 };
    }
    const d = lev(norm(a, { accents: false }), norm(typed, { accents: false }));
    if (d < bestD) { bestD = d; best = a; }
  }
  const len = norm(best).length;
  const allowed = len <= 4 ? 1 : Math.max(1, Math.round(len / 8));
  if (bestD <= allowed) return { verdict: 'close', best, suggested: 2 };
  return { verdict: 'wrong', best, suggested: 1 };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** HTML diff of the typed answer against the correct one (word level for sentences, char level for words). */
export function diffHtml(typed, correct) {
  const words = /\s/.test(correct.trim());
  const A = words ? typed.trim().split(/\s+/) : [...typed.trim()];
  const B = words ? correct.trim().split(/\s+/) : [...correct.trim()];
  const key = x => (words ? norm(x, { accents: false }) : stripMarks(x.toLowerCase()));
  const m = A.length, n = B.length;
  const L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
    L[i][j] = key(A[i]) === key(B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = []; let i = 0, j = 0;
  const sep = words ? ' ' : '';
  while (i < m && j < n) {
    if (key(A[i]) === key(B[j])) {
      const exact = norm(A[i]) === norm(B[j]);
      out.push(exact ? `<span class="d-ok">${esc(B[j])}</span>` : `<span class="d-acc">${esc(B[j])}</span>`);
      i++; j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      out.push(`<span class="d-del">${esc(A[i])}</span>`); i++;
    } else {
      out.push(`<span class="d-add">${esc(B[j])}</span>`); j++;
    }
  }
  while (i < m) out.push(`<span class="d-del">${esc(A[i++])}</span>`);
  while (j < n) out.push(`<span class="d-add">${esc(B[j++])}</span>`);
  return out.join(sep);
}
