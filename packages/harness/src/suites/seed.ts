import type { EvalTask } from "../types";

type Draft = Omit<EvalTask, "suite" | "id">;

const code = (lang: "es" | "en", fn: string, spec: string, tests: string, reference: string): Draft => ({
  lang,
  type: "coding",
  prompt:
    lang === "es"
      ? `Escribe en JavaScript (ES modules, sin dependencias) ${spec} Responde con un único bloque de código.`
      : `Write in JavaScript (ES modules, no dependencies) ${spec} Reply with a single code block.`,
  check: { kind: "code_tests", tests },
  reference: "```js\n" + reference + "\n```",
});

const DRAFTS: Draft[] = [
  // --- short factual QA ---
  { lang: "es", type: "qa_simple", prompt: "¿Cuál es la capital de Australia? Responde solo con el nombre.", check: { kind: "exact", answer: "Canberra" }, reference: "Canberra" },
  { lang: "en", type: "qa_simple", prompt: "What is the chemical symbol for gold? Answer with the symbol only.", check: { kind: "exact", answer: "Au" }, reference: "Au" },
  { lang: "es", type: "qa_simple", prompt: "¿Cuántos lados tiene un hexágono? Responde solo con el número.", check: { kind: "number", value: 6, tolerance: 0 }, reference: "6" },
  { lang: "en", type: "qa_simple", prompt: "Who wrote 'Don Quixote'? Answer with the surname only.", check: { kind: "exact", answer: "Cervantes" }, reference: "Cervantes" },
  { lang: "es", type: "qa_simple", prompt: "¿En qué año llegó el ser humano a la Luna por primera vez? Solo el año.", check: { kind: "number", value: 1969, tolerance: 0 }, reference: "1969" },
  { lang: "en", type: "qa_simple", prompt: "What is the largest planet in the Solar System? One word.", check: { kind: "exact", answer: "Jupiter" }, reference: "Jupiter" },
  { lang: "es", type: "qa_simple", prompt: "¿Cuál es el río más largo de Sudamérica? Responde solo con el nombre.", check: { kind: "regex", pattern: "amazon", flags: "i" }, reference: "El Amazonas" },
  { lang: "en", type: "qa_simple", prompt: "Which gas do plants absorb from the air for photosynthesis? One or two words.", check: { kind: "regex", pattern: "carbon dioxide|co2", flags: "i" }, reference: "Carbon dioxide" },

  // --- arithmetic and reasoning (answer is a number) ---
  { lang: "es", type: "qa_simple", prompt: "Calcula 17 × 23. Responde solo con el número.", check: { kind: "number", value: 391, tolerance: 0 }, reference: "391" },
  { lang: "en", type: "qa_simple", prompt: "What is 15% of 240? Answer with just the number.", check: { kind: "number", value: 36, tolerance: 0 }, reference: "36" },
  { lang: "es", type: "qa_simple", prompt: "Un tren sale a las 14:30 y llega a las 17:05. ¿Cuántos minutos dura el viaje? Solo el número.", check: { kind: "number", value: 155, tolerance: 0 }, reference: "155" },
  { lang: "en", type: "qa_simple", prompt: "A shop sells pens at 3 for $2. How many dollars do 18 pens cost? Number only.", check: { kind: "number", value: 12, tolerance: 0 }, reference: "12" },
  { lang: "es", type: "explanation", prompt: "Si 5 máquinas hacen 5 piezas en 5 minutos, ¿cuántos minutos tardan 100 máquinas en hacer 100 piezas? Solo el número.", check: { kind: "number", value: 5, tolerance: 0 }, reference: "5" },
  { lang: "en", type: "qa_simple", prompt: "What is the sum of all integers from 1 to 100? Number only.", check: { kind: "number", value: 5050, tolerance: 0 }, reference: "5050" },
  { lang: "es", type: "explanation", prompt: "María tiene el triple de edad que su hijo. Dentro de 12 años tendrá el doble. ¿Cuántos años tiene el hijo ahora? Solo el número.", check: { kind: "number", value: 12, tolerance: 0 }, reference: "12" },
  { lang: "en", type: "explanation", prompt: "How many distinct arrangements of the letters in the word 'LEVEL' are there? Number only.", check: { kind: "number", value: 30, tolerance: 0 }, reference: "30" },
  { lang: "es", type: "qa_simple", prompt: "Calcula 987 × 654 y responde solo con el número.", check: { kind: "number", value: 645498, tolerance: 0 }, reference: "645498" },
  { lang: "en", type: "explanation", prompt: "What is the remainder when 2^100 is divided by 7? Number only.", check: { kind: "number", value: 2, tolerance: 0 }, reference: "2" },
  { lang: "es", type: "explanation", prompt: "Una piscina se llena con un grifo en 6 horas y con otro en 3 horas. ¿Cuántas horas tardan con ambos abiertos? Solo el número.", check: { kind: "number", value: 2, tolerance: 0 }, reference: "2" },
  { lang: "en", type: "explanation", prompt: "How many positive divisors does 360 have? Number only.", check: { kind: "number", value: 24, tolerance: 0 }, reference: "24" },

  // --- instruction following ---
  { lang: "es", type: "other", prompt: "Escribe una sola frase de exactamente 5 palabras sobre el mar. No uses signos de puntuación.", check: { kind: "regex", pattern: "^\\s*[^\\s.,;:!?¡¿]+(?:\\s+[^\\s.,;:!?¡¿]+){4}\\s*$" }, reference: "El mar brilla muy azul" },
  { lang: "en", type: "other", prompt: 'Reply with a JSON object with exactly the keys "name" and "age" and nothing else, for a person called Ana aged 30.', check: { kind: "regex", pattern: '^\\s*(?:```json\\s*)?\\{\\s*"name"\\s*:\\s*"Ana"\\s*,\\s*"age"\\s*:\\s*30\\s*\\}\\s*(?:```)?\\s*$' }, reference: '{"name": "Ana", "age": 30}' },
  { lang: "es", type: "qa_simple", prompt: "Responde únicamente con la palabra SÍ en mayúsculas si 91 es un número primo, o NO en caso contrario.", check: { kind: "exact", answer: "NO" }, reference: "NO" },
  { lang: "en", type: "other", prompt: "Write the word 'banana' backwards. Answer with the reversed word only.", check: { kind: "exact", answer: "ananab" }, reference: "ananab" },
  { lang: "es", type: "other", prompt: "Ordena alfabéticamente estas palabras y sepáralas con comas, sin espacios: zorro, abeja, mesa, casa", check: { kind: "regex", pattern: "^\\W*abeja,casa,mesa,zorro\\W*$", flags: "i" }, reference: "abeja,casa,mesa,zorro" },
  { lang: "en", type: "other", prompt: "List the days of the week that start with the letter T, separated by a single space, in calendar order, in lowercase.", check: { kind: "regex", pattern: "^\\W*tuesday thursday\\W*$" }, reference: "tuesday thursday" },

  // --- extraction and classification ---
  { lang: "es", type: "other", prompt: "Extrae el correo electrónico del texto: 'Contacta con ventas escribiendo a ventas@ejemplo.com antes del viernes.' Responde solo con el correo.", check: { kind: "exact", answer: "ventas@ejemplo.com" }, reference: "ventas@ejemplo.com" },
  { lang: "en", type: "other", prompt: "Classify the sentiment of this review as positive, negative or neutral: 'The battery died after two days and support never answered.' One word.", check: { kind: "exact", answer: "negative" }, reference: "negative" },
  { lang: "es", type: "qa_simple", prompt: "¿Cuál de estas palabras no pertenece al grupo: manzana, pera, zanahoria, plátano? Solo la palabra.", check: { kind: "exact", answer: "zanahoria" }, reference: "zanahoria" },
  { lang: "en", type: "other", prompt: "Extract the total amount from: 'Invoice #4471 — subtotal $120.00, tax $9.60, total due $129.60.' Reply with the number only.", check: { kind: "number", value: 129.6, tolerance: 0.001 }, reference: "129.60" },
  { lang: "es", type: "other", prompt: "Traduce al inglés: 'Buenos días, ¿cómo estás?' Responde solo con la traducción.", check: { kind: "regex", pattern: "^\\W*good morning,?\\s+how are you\\W*$", flags: "i" }, reference: "Good morning, how are you?" },
  { lang: "en", type: "qa_simple", prompt: "What is the plural of 'mouse' (the animal)? One word.", check: { kind: "exact", answer: "mice" }, reference: "mice" },

  // --- coding with executable tests ---
  code("es", "sumEven", "una función `sumEven(arr)` que devuelva la suma de los números pares de un arreglo (0 si no hay).",
    `assert.equal(sumEven([1,2,3,4]), 6); assert.equal(sumEven([]), 0); assert.equal(sumEven([-2,5]), -2);`,
    `export function sumEven(arr) { return arr.filter((n) => n % 2 === 0).reduce((a, b) => a + b, 0); }`),
  code("en", "isPalindrome", "a function `isPalindrome(s)` that ignores case and non-alphanumeric characters.",
    `assert.equal(isPalindrome("A man, a plan, a canal: Panama"), true); assert.equal(isPalindrome("hello"), false); assert.equal(isPalindrome(""), true);`,
    `export function isPalindrome(s) { const t = s.toLowerCase().replace(/[^a-z0-9]/g, ""); return t === [...t].reverse().join(""); }`),
  code("es", "fizzbuzz", "una función `fizzbuzz(n)` que devuelva un arreglo de strings de 1 a n: 'Fizz' para múltiplos de 3, 'Buzz' para múltiplos de 5, 'FizzBuzz' para ambos y el número como string en otro caso.",
    `assert.deepEqual(fizzbuzz(5), ["1","2","Fizz","4","Buzz"]); assert.equal(fizzbuzz(15)[14], "FizzBuzz"); assert.deepEqual(fizzbuzz(0), []);`,
    `export function fizzbuzz(n) { const r = []; for (let i = 1; i <= n; i++) r.push(i % 15 === 0 ? "FizzBuzz" : i % 3 === 0 ? "Fizz" : i % 5 === 0 ? "Buzz" : String(i)); return r; }`),
  code("en", "romanToInt", "a function `romanToInt(s)` converting a Roman numeral (up to 3999) to an integer.",
    `assert.equal(romanToInt("III"), 3); assert.equal(romanToInt("IV"), 4); assert.equal(romanToInt("IX"), 9); assert.equal(romanToInt("LVIII"), 58); assert.equal(romanToInt("MCMXCIV"), 1994);`,
    `export function romanToInt(s) { const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }; let t = 0; for (let i = 0; i < s.length; i++) { const a = v[s[i]], b = v[s[i + 1]] ?? 0; t += a < b ? -a : a; } return t; }`),
  code("es", "isBalanced", "una función `isBalanced(s)` que diga si los paréntesis, corchetes y llaves de un string están bien balanceados y anidados (ignora otros caracteres).",
    `assert.equal(isBalanced("([]{})"), true); assert.equal(isBalanced("([)]"), false); assert.equal(isBalanced("(("), false); assert.equal(isBalanced(""), true); assert.equal(isBalanced("a(b)c"), true);`,
    `export function isBalanced(s) { const pairs = { ")": "(", "]": "[", "}": "{" }; const st = []; for (const c of s) { if ("([{".includes(c)) st.push(c); else if (c in pairs) { if (st.pop() !== pairs[c]) return false; } } return st.length === 0; }`),
  code("en", "mergeIntervals", "a function `mergeIntervals(intervals)` that takes an array of [start, end] pairs (possibly unsorted) and returns the merged, sorted, non-overlapping intervals; touching intervals ([1,4] and [4,5]) are merged.",
    `assert.deepEqual(mergeIntervals([[1,3],[2,6],[8,10],[15,18]]), [[1,6],[8,10],[15,18]]); assert.deepEqual(mergeIntervals([[1,4],[4,5]]), [[1,5]]); assert.deepEqual(mergeIntervals([]), []); assert.deepEqual(mergeIntervals([[5,6],[1,2],[2,3]]), [[1,3],[5,6]]);`,
    `export function mergeIntervals(iv) { const s = iv.map((x) => [...x]).sort((a, b) => a[0] - b[0]); const out = []; for (const x of s) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push(x); } return out; }`),
  code("es", "LRUCache", "una clase `LRUCache` con constructor(capacity), `get(key)` (devuelve -1 si no existe y marca la clave como usada recientemente) y `put(key, value)` (expulsa la clave menos usada recientemente al superar la capacidad).",
    `const c = new LRUCache(2); c.put(1,1); c.put(2,2); assert.equal(c.get(1), 1); c.put(3,3); assert.equal(c.get(2), -1); c.put(4,4); assert.equal(c.get(1), -1); assert.equal(c.get(3), 3); assert.equal(c.get(4), 4);`,
    `export class LRUCache { constructor(c) { this.c = c; this.m = new Map(); } get(k) { if (!this.m.has(k)) return -1; const v = this.m.get(k); this.m.delete(k); this.m.set(k, v); return v; } put(k, v) { this.m.delete(k); this.m.set(k, v); if (this.m.size > this.c) this.m.delete(this.m.keys().next().value); } }`),
  code("en", "groupBy", "a function `groupBy(arr, fn)` returning an object that maps each key `fn(item)` to the array of items with that key, preserving order.",
    `assert.deepEqual(groupBy([1,2,3,4], (x) => (x % 2 ? "odd" : "even")), { odd: [1,3], even: [2,4] }); assert.deepEqual(groupBy([], (x) => x), {}); assert.deepEqual(groupBy(["a","bb","cc"], (s) => s.length), { 1: ["a"], 2: ["bb","cc"] });`,
    `export function groupBy(arr, fn) { const o = {}; for (const x of arr) (o[fn(x)] ??= []).push(x); return o; }`),
  code("es", "longestCommonPrefix", "una función `longestCommonPrefix(strs)` que devuelva el prefijo común más largo de un arreglo de strings (cadena vacía si no hay o el arreglo está vacío).",
    `assert.equal(longestCommonPrefix(["flower","flow","flight"]), "fl"); assert.equal(longestCommonPrefix(["dog","racecar"]), ""); assert.equal(longestCommonPrefix([]), ""); assert.equal(longestCommonPrefix(["same"]), "same");`,
    `export function longestCommonPrefix(strs) { if (!strs.length) return ""; let p = strs[0]; for (const s of strs) while (!s.startsWith(p)) p = p.slice(0, -1); return p; }`),
  code("en", "twoSum", "a function `twoSum(nums, target)` returning the indices [i, j] with i < j of the two numbers that add up to target (exactly one solution exists).",
    `assert.deepEqual(twoSum([2,7,11,15], 9), [0,1]); assert.deepEqual(twoSum([3,2,4], 6), [1,2]); assert.deepEqual(twoSum([3,3], 6), [0,1]);`,
    `export function twoSum(nums, target) { const seen = new Map(); for (let j = 0; j < nums.length; j++) { const i = seen.get(target - nums[j]); if (i !== undefined) return [i, j]; seen.set(nums[j], j); } }`),
  code("es", "parseDuration", "una función `parseDuration(s)` que convierta un texto como '1h30m', '45s' o '1h1m1s' (unidades h, m, s, en ese orden, todas opcionales pero al menos una) a segundos.",
    `assert.equal(parseDuration("1h30m"), 5400); assert.equal(parseDuration("45s"), 45); assert.equal(parseDuration("2h"), 7200); assert.equal(parseDuration("1h1m1s"), 3661);`,
    `export function parseDuration(s) { const m = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(s); return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0); }`),
];

export const SEED_SUITE_NAME = "seed";

export const seedSuite: EvalTask[] = DRAFTS.map((d, i) => ({ ...d, suite: SEED_SUITE_NAME, id: `${SEED_SUITE_NAME}-${String(i + 1).padStart(3, "0")}` }));
