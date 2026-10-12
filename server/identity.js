// Conservative name comparison for source identity checks. Unknown scripts
// and missing name parts require review; they are not proof of another person.
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'smt', 'sri', 'shri', 'kum', 'prof']);
const parts = (name) => String(name ?? '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter((word) => word && !TITLES.has(word));
const scripts = ['Latin', 'Devanagari', 'Kannada', 'Tamil', 'Telugu', 'Bengali', 'Malayalam', 'Gujarati', 'Gurmukhi', 'Oriya', 'Arabic', 'Cyrillic', 'Han', 'Hangul', 'Hebrew'];
const scriptPatterns = scripts.map((script) => new RegExp(`\\p{Script_Extensions=${script}}`, 'u'));
const scriptSet = (name) => new Set(scriptPatterns.flatMap((pattern, index) => pattern.test(name) ? [scripts[index]] : []));
const oneEdit = (a, b) => {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let index = 0;
  while (index < a.length && a[index] === b[index]) index += 1;
  return a.slice(index + 1) === b.slice(index + 1) || a.slice(index) === b.slice(index + 1) || a.slice(index + 1) === b.slice(index);
};

export function nameRelationship(expected, written) {
  const a = parts(expected), b = parts(written);
  if (!a.length || !b.length) return 'unknown';
  if (a.join(' ') === b.join(' ')) return 'same';
  const expectedScripts = scriptSet(a.join('')), writtenScripts = scriptSet(b.join(''));
  if (!expectedScripts.size || !writtenScripts.size || expectedScripts.size !== writtenScripts.size || ![...expectedScripts].every((script) => writtenScripts.has(script))) return 'unknown';
  // Match exact parts before initials/fuzzy variants so an initial cannot
  // consume a surname needed for an exact match later in the same name.
  let matched = 0;
  const pair = (accept) => {
    for (let i = a.length - 1; i >= 0; i -= 1) {
      const index = b.findIndex((word) => accept(a[i], word));
      if (index === -1) continue;
      a.splice(i, 1); b.splice(index, 1); matched += 1;
    }
  };
  pair((x, y) => x === y);
  pair(oneEdit);
  pair((x, y) => (x.length === 1 || y.length === 1) && x[0] === y[0]);
  if (a.length && b.length) return 'conflict';
  return matched ? 'compatible' : 'unknown';
}

export const definiteNameConflict = (expected, written) => nameRelationship(expected, written) === 'conflict';
