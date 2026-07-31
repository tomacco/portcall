// Silly-name forge. Choosing one of these is a guideline, not a law.
// The Who-You-Are rule (whoami) is the law. See registry.ts.

const TITLES = [
  'Captain', 'Admiral', 'Baroness', 'Duke', 'Professor', 'Sir', 'Dame',
  'Commodore', 'Archduke', 'Chancellor', 'First Mate', 'Quartermaster',
];

const ADJECTIVES = [
  'Wobbly', 'Recursive', 'Feral', 'Polite', 'Untested', 'Async', 'Crispy',
  'Haunted', 'Turbo', 'Bashful', 'Volatile', 'Deprecated', 'Sparkling',
  'Nocturnal', 'Overclocked', 'Suspicious', 'Buoyant', 'Grumpy',
];

const NOUNS = [
  'Bitflip', 'Segfault', 'Teapot', 'Mongoose', 'Pancake', 'Nullptr',
  'Walrus', 'Crouton', 'Bagpipe', 'Semicolon', 'Kraken', 'Wombat',
  'Turnip', 'Mutex', 'Gherkin', 'Doubloon', 'Barnacle', 'Yak',
];

const SUFFIXES = ['', '', '', ' III', ' Jr.', ' the Unmerged', ' of the North Port', ' Esq.'];

function pick(arr: readonly string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function suggestName(): string {
  return `${pick(TITLES)} ${pick(ADJECTIVES)} ${pick(NOUNS)}${pick(SUFFIXES)}`;
}

export function suggestMany(n = 5): string[] {
  const out = new Set<string>();
  while (out.size < n) out.add(suggestName());
  return [...out];
}
