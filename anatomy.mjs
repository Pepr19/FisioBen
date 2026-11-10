// Exact matching only: a tendon/bursa with a muscle's name must never inherit its card.
export function cleanName(name) { return name.replace(/\.[lr]$/, '').replace(/^\((.*)\)$/, '$1'); }
export function normalizeName(name) { return cleanName(name).toLowerCase(); }
export function searchText(text) { return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
export function createCardIndex(data) {
  const map = new Map();
  for (const card of data.cards) for (const model of card.models) {
    const key = normalizeName(model);
    if (map.has(key)) throw new Error('Duplicate card mapping: ' + model);
    map.set(key, card);
  }
  return map;
}
export function cardFor(entry, index) {
  return entry?.sys === 'muscular' ? index.get(normalizeName(entry.name)) || null : null;
}
export function matchesEntry(entry, card, {query = '', region = '', onlyCards = false}, label = '', aliases = [], latin = '') {
  if (onlyCards && !card) return false;
  if (region && card?.region !== region) return false;
  const terms = searchText(query).split(/\s+/).filter(Boolean);
  const haystack = searchText([entry.name, label, latin, ...aliases, card?.name, card?.region, card?.origin, card?.insertion, card?.actions, card?.innervation].filter(Boolean).join(' '));
  return terms.every(term => haystack.includes(term));
}
