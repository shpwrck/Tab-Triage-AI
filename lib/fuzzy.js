// Lightweight fuzzy matcher used by the global popup search.
//
// Two functions are exported:
//   fuzzyScore(query, text)      → 0 if no match, otherwise a positive score
//   fuzzyScoreMulti(query, text) → splits the query on whitespace; every
//                                  token must match (each contributes to score)
//
// Scoring (rough order of magnitude):
//   - Exact substring is heavily preferred (base 10000, +500 if it lands on a
//     word boundary, small penalty for how far in the text the match starts).
//   - Otherwise a subsequence match: characters of the query must appear in
//     order in the text. Each matched character scores 1 point, +8 for landing
//     on a word boundary (start of string, after whitespace/punct/underscore),
//     +4 for hitting a camelCase boundary, +5 if it's adjacent to the previous
//     matched character (consecutive run bonus).
//   - Returning 0 means no match — drop the candidate.
//
// No dependencies, no library — the project has no bundler.

export function fuzzyScore(query, text) {
  if (!query || !text) return 0;
  const q = query.toLowerCase();
  const tLower = text.toLowerCase();

  const idx = tLower.indexOf(q);
  if (idx !== -1) {
    const prevChar = idx > 0 ? text[idx - 1] : "";
    const atBoundary = idx === 0 || /[\s\W_]/.test(prevChar);
    return 10000 + (atBoundary ? 500 : 0) - Math.min(idx, 400);
  }

  let score = 0;
  let qi = 0;
  let prevMatchIdx = -2;

  for (let ti = 0; ti < text.length && qi < q.length; ti++) {
    if (tLower[ti] !== q[qi]) continue;

    let charPoints = 1;
    const prev = ti > 0 ? text[ti - 1] : "";
    const here = text[ti];
    const isWordStart = ti === 0 || /[\s\W_]/.test(prev);
    const isCamelStart =
      ti > 0 && here >= "A" && here <= "Z" && prev >= "a" && prev <= "z";
    if (isWordStart) charPoints += 8;
    else if (isCamelStart) charPoints += 4;
    if (prevMatchIdx === ti - 1) charPoints += 5;

    score += charPoints;
    prevMatchIdx = ti;
    qi++;
  }

  if (qi < q.length) return 0;
  return Math.max(score, 1);
}

export function fuzzyScoreMulti(query, text) {
  const tokens = (query || "").split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  let total = 0;
  for (const tok of tokens) {
    const s = fuzzyScore(tok, text);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}
