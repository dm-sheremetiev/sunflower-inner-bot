// Регрес-тест для aggregatePosterProducts (src/services/poster.service.ts).
// Запуск: npx tsx src/scripts/testAggregatePosterProducts.ts
//
// Покриває:
//  - адитивні групові модифікації одного товару (корзина/коробка + ОАЗИС) → count НЕ задвоюється
//  - справжні дублі (однакова модифікація) → count сумується (захист від error 99)
//  - звичайні дублі без модифікацій → count сумується
//  - різні product_id та modificator_id не зачіпаються

import { aggregatePosterProducts } from "../services/poster.service.js";

type Product = Parameters<typeof aggregatePosterProducts>[0][number];

let failures = 0;

const assert = (name: string, cond: boolean, details?: unknown) => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
    if (details !== undefined) {
      console.error("    got:", JSON.stringify(details));
    }
  }
};

const mods = (entries: Array<{ m: number; a: number }>): string =>
  JSON.stringify([...entries].sort((x, y) => x.m - y.m));

// 1. Корзина 1885: Біла (175) + ОАЗИС (186) — одна group_modification, аддитивна.
console.log("1) basket + oasis (order 32576) — base count must stay 1");
{
  const out = aggregatePosterProducts([
    { product_id: 1885, count: 1, modification: mods([{ m: 175, a: 1 }]) },
    { product_id: 1885, count: 1, modification: mods([{ m: 186, a: 1 }]) },
  ] as Product[]);
  assert("merges into a single line", out.length === 1, out);
  assert("count is 1, not 2 (no basket duplication)", out[0]?.count === 1, out[0]);
  assert(
    "both modifications kept with a=1",
    out[0]?.modification === mods([{ m: 175, a: 1 }, { m: 186, a: 1 }]),
    out[0]?.modification,
  );
}

// 2. Оксамитова коробка 1982: Коробка чорна (201) + ОАЗИС (207) (order 32583).
console.log("2) box + oasis (order 32583) — base count must stay 1");
{
  const out = aggregatePosterProducts([
    { product_id: 1982, count: 1, modification: mods([{ m: 207, a: 1 }]) },
    { product_id: 1982, count: 1, modification: mods([{ m: 201, a: 1 }]) },
  ] as Product[]);
  assert("single line", out.length === 1, out);
  assert("count is 1", out[0]?.count === 1, out[0]);
  assert(
    "both dish modifications present",
    out[0]?.modification === mods([{ m: 201, a: 1 }, { m: 207, a: 1 }]),
    out[0]?.modification,
  );
}

// 3. Кілька базових (2 корзини + 2 ОАЗИС) — кількість іде в a, count лишається 1.
console.log("3) 2 baskets + 2 oasis — quantity goes into a, count stays 1");
{
  const out = aggregatePosterProducts([
    { product_id: 1885, count: 2, modification: mods([{ m: 175, a: 2 }]) },
    { product_id: 1885, count: 2, modification: mods([{ m: 186, a: 2 }]) },
  ] as Product[]);
  assert("single line", out.length === 1, out);
  assert("count is 1", out[0]?.count === 1, out[0]);
  assert(
    "a carries quantities (175→2, 186→2)",
    out[0]?.modification === mods([{ m: 175, a: 2 }, { m: 186, a: 2 }]),
    out[0]?.modification,
  );
}

// 4. Справжні дублі: однакова модифікація ×3 → count сумується (захист від error 99).
console.log("4) identical compositions ×3 — count summed (error 99 guard preserved)");
{
  const out = aggregatePosterProducts([
    { product_id: 5000, count: 1, modification: mods([{ m: 99, a: 1 }]) },
    { product_id: 5000, count: 1, modification: mods([{ m: 99, a: 1 }]) },
    { product_id: 5000, count: 1, modification: mods([{ m: 99, a: 1 }]) },
  ] as Product[]);
  assert("single line", out.length === 1, out);
  assert("count summed to 3", out[0]?.count === 3, out[0]);
  assert(
    "a summed to 3",
    out[0]?.modification === mods([{ m: 99, a: 3 }]),
    out[0]?.modification,
  );
}

// 5. Звичайні дублі без модифікацій → count сумується.
console.log("5) plain duplicate products — count summed");
{
  const out = aggregatePosterProducts([
    { product_id: 666, count: 1 },
    { product_id: 666, count: 2 },
  ] as Product[]);
  assert("single line", out.length === 1, out);
  assert("count summed to 3", out[0]?.count === 3, out[0]);
  assert("no modification field", out[0]?.modification === undefined, out[0]);
}

// 6. Різні product_id не схлопуються.
console.log("6) distinct products are not merged");
{
  const out = aggregatePosterProducts([
    { product_id: 1894, count: 10 },
    { product_id: 1697, count: 6 },
  ] as Product[]);
  assert("two lines preserved", out.length === 2, out);
  assert("counts untouched", out[0]?.count === 10 && out[1]?.count === 6, out);
}

// 7. modificator_id (CT_1025) лінія дублюється → count сумується, modificator_id збережено.
console.log("7) modificator_id line duplicates — count summed, modificator_id kept");
{
  const out = aggregatePosterProducts([
    { product_id: 1749, count: 3, modificator_id: 3813 },
    { product_id: 1749, count: 2, modificator_id: 3813 },
  ] as Product[]);
  assert("single line", out.length === 1, out);
  assert("count summed to 5", out[0]?.count === 5, out[0]);
  assert("modificator_id preserved", out[0]?.modificator_id === 3813, out[0]);
}

console.log();
if (failures > 0) {
  console.error(`FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
// Імпорт poster.service тягне за собою server.js (через keycrmApiClient),
// тож процес не завершиться сам — виходимо явно.
console.log("All aggregatePosterProducts checks passed.");
process.exit(0);
