// Infinite generator pattern - my favorite snippet
const naturals = (n: number = 0): Generator<number> => {
  while (true) yield n++;
};

const take = (gen: Generator<number>, n: number): number[] => {
  const result: number[] = [];
  for (const val of gen) {
    if (--n < 0) break;
    result.push(val);
  }
  return result;
};

// Usage: take(naturals(), 10) → [0,1,2,3,4,5,6,7,8,9]
