/**
 * Labelled question groups for the semantic cache (ADR-0015, R2).
 * `same`: rewordings that SHOULD be served from the cached canonical answer.
 * `different`: look-alikes that MUST NOT be served from it (a different entity, number or intent).
 * Cross-group look-alikes are checked automatically too.
 */
export interface InstantGroup {
  canonical: string;
  same: string[];
  different: string[];
}

export const instantGroups: InstantGroup[] = [
  { canonical: "cuál es la capital de Francia", same: ["dime la capital de Francia", "capital de francia por favor", "cual es la capital de francia?", "cuál es la capitla de Francia"], different: ["cuál es la capital de Italia", "cuál es la población de Francia", "cuál es la capital de Francia en 1700"] },
  { canonical: "what is the capital of Japan", same: ["tell me the capital of Japan", "capital of japan please", "What's the capital of Japan?"], different: ["what is the capital of China", "what is the currency of Japan", "cuál es la capital de Japón"] },
  { canonical: "cuánto es 17 por 23", same: ["cuánto es 17 por 23?", "dime cuánto es 17 por 23"], different: ["cuánto es 17 por 24", "cuánto es 27 por 23", "cuánto es 17 más 23"] },
  { canonical: "explica qué es un closure en JavaScript", same: ["explícame qué es un closure en javascript", "qué es un closure en JavaScript", "explain what a closure is in JavaScript"], different: ["explica qué es un closure en Python", "explica qué es una promesa en JavaScript", "explica qué es un closure en Rust"] },
  { canonical: "qué es la fotosíntesis", same: ["dime qué es la fotosíntesis", "que es la fotosintesis", "explícame qué es la fotosíntesis"], different: ["qué es la respiración celular", "qué es la fotosíntesis artificial"] },
  { canonical: "what is the difference between TCP and UDP", same: ["difference between TCP and UDP", "what's the difference between tcp and udp?", "can you tell me the difference between TCP and UDP"], different: ["what is the difference between TCP and HTTP", "what is the difference between UDP and QUIC"] },
  { canonical: "cómo funciona un motor de combustión", same: ["explícame cómo funciona un motor de combustión", "como funciona un motor de combustion"], different: ["cómo funciona un motor eléctrico", "cómo funciona un motor diésel"] },
  { canonical: "quién escribió Cien años de soledad", same: ["dime quién escribió Cien años de soledad", "quien escribio cien anos de soledad"], different: ["quién escribió Don Quijote", "quién protagonizó Cien años de soledad"] },
  { canonical: "cuántos días tiene un año bisiesto", same: ["dime cuántos días tiene un año bisiesto", "cuantos dias tiene un ano bisiesto"], different: ["cuántos días tiene febrero", "cuántos días tiene un año normal"] },
  { canonical: "what is the speed of light", same: ["tell me the speed of light", "speed of light please", "what's the speed of light?"], different: ["what is the speed of sound", "what is the speed of light in water"] },
  { canonical: "qué significa la palabra efímero", same: ["dime qué significa la palabra efímero", "que significa efimero"], different: ["qué significa la palabra efusivo", "qué significa la palabra etéreo"] },
  { canonical: "cuál es el planeta más grande del sistema solar", same: ["dime cuál es el planeta más grande del sistema solar", "cual es el planeta mas grande del sistema solar?"], different: ["cuál es el planeta más pequeño del sistema solar", "cuál es el planeta más caliente del sistema solar"] },
  { canonical: "how many bits are in a byte", same: ["how many bits in a byte", "tell me how many bits are in a byte"], different: ["how many bytes are in a kilobyte", "how many bits are in a nibble"] },
  { canonical: "explica la diferencia entre let y const", same: ["explícame la diferencia entre let y const", "diferencia entre let y const"], different: ["explica la diferencia entre let y var", "explica la diferencia entre const y readonly"] },
  { canonical: "qué es una API REST", same: ["dime qué es una API REST", "explícame qué es una API REST", "que es una api rest"], different: ["qué es una API GraphQL", "qué es una API"] },
];
