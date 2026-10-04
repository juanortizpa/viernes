/**
 * Labelled corpus for long-term memory retrieval (ADR-0023). Written by hand, BEFORE looking at any score, for an invented user.
 * `facts`: what the user asked to remember. `queries`: what they ask later.
 *  - relevant: the memories that should be put into the prompt (`want`), plus ones that would be acceptable (`also`).
 *  - none: nothing about the user is needed; injecting a memory is a false injection.
 * `hard` marks the cases that are hard on purpose: a relevant memory with no shared word (semantic gap), or a question that
 * mentions a memory's topic word in a different sense (hard negative).
 */
export interface MemoryFactSpec {
  key: string;
  text: string;
}

export interface MemoryQuerySpec {
  q: string;
  /** Keys of memories that should be retrieved. Empty: nothing should be. */
  want: string[];
  /** Keys that are fine to retrieve as well (ambiguous references), never counted as false injections. */
  also?: string[];
  hard?: "semantic-gap" | "hard-negative";
}

export const memoryFacts: MemoryFactSpec[] = [
  { key: "hermana", text: "Mi hermana se llama Ana y le encanta el té verde" },
  { key: "gato", text: "Mi gato se llama Pelusa y le gusta el atún" },
  { key: "ciudad", text: "Vivo en Bogotá desde 2019" },
  { key: "trabajo", text: "Trabajo como ingeniero de datos en una empresa de logística" },
  { key: "cumple", text: "Mi cumpleaños es el 3 de mayo" },
  { key: "alergia", text: "Soy alérgico a los mariscos y a la penicilina" },
  { key: "codigo", text: "Programo principalmente en Python y TypeScript" },
  { key: "uni", text: "Estudié ingeniería de sistemas en la Universidad Nacional" },
  { key: "pareja", text: "Mi pareja se llama Laura y es veterinaria" },
  { key: "carro", text: "Mi carro es un Mazda 3 rojo del 2018" },
  { key: "hobby", text: "Los fines de semana toco la guitarra y salgo a correr" },
  { key: "comida", text: "Mi comida favorita es la bandeja paisa" },
  { key: "equipo", text: "Soy hincha del Atlético Nacional" },
  { key: "mama", text: "Mi mamá vive en Medellín y se llama Marta" },
  { key: "viaje", text: "El año pasado viajé a Lisboa y quiero volver a Portugal" },
  { key: "idioma", text: "Hablo español nativo e inglés intermedio" },
  { key: "gym", text: "Voy al gimnasio los martes y jueves a las 6 am" },
  { key: "tesis", text: "Estoy construyendo un asistente personal llamado JARVIS como tesis" },
  { key: "cafe", text: "Tomo el café sin azúcar y con leche de avena" },
  { key: "dentista", text: "My dentist appointment is every six months at Clínica Dental Norte" },
  { key: "hermano", text: "My brother Daniel lives in Toronto and works at a bank" },
  { key: "escritorio", text: "I use a standing desk and a 34-inch ultrawide monitor" },
  { key: "libro", text: "My favorite book is One Hundred Years of Solitude" },
  { key: "maraton", text: "I'm training for a half marathon in October" },
  { key: "router", text: "My wifi router is a TP-Link Archer in the living room" },
  { key: "hija", text: "Mi hija Sofía tiene 6 años y va al colegio San José" },
  { key: "jefe", text: "Mi jefe se llama Carlos y las reuniones de equipo son los lunes a las 9" },
  { key: "bici", text: "Tengo una bicicleta de montaña Trek y la llevo al taller cada seis meses" },
  { key: "plan", text: "Mi plan de datos es de 20 GB con Claro" },
  // Standing preferences: always injected, so they are not part of the retrieval labels.
  { key: "p-corto", text: "prefiero respuestas cortas y directas" },
  { key: "p-tuteo", text: "siempre tutéame" },
  { key: "p-musica", text: "me gusta el jazz y la salsa" },
  { key: "p-ingles", text: "when I write in English, answer in English" },
];

export const memoryQueries: MemoryQuerySpec[] = [
  // ---- relevant ----
  { q: "cómo se llama mi gato", want: ["gato"] },
  { q: "qué le puedo regalar a mi hermana por su cumpleaños", want: ["hermana"], also: ["cumple"] },
  { q: "recomiéndame un restaurante cerca de donde vivo", want: ["ciudad"], also: ["comida"] },
  { q: "ayúdame a escribir un correo para mi jefe sobre la reunión del lunes", want: ["jefe"] },
  { q: "qué día es mi cumpleaños", want: ["cumple"] },
  { q: "escribe una función en Python para ordenar una lista", want: ["codigo"] },
  { q: "qué carrera estudié", want: ["uni"] },
  { q: "qué crees que hace Laura hoy", want: ["pareja"] },
  { q: "cuánto cuesta el seguro de mi carro", want: ["carro"] },
  { q: "sugiere un plan para mis fines de semana", want: ["hobby"], also: ["gym"] },
  { q: "cocina algo con mi comida favorita", want: ["comida"] },
  { q: "cómo le fue al Atlético Nacional", want: ["equipo"] },
  { q: "cómo está el clima en Medellín donde vive mi mamá", want: ["mama"] },
  { q: "recomiéndame qué hacer en Lisboa", want: ["viaje"] },
  { q: "a qué hora voy al gimnasio los martes", want: ["gym"] },
  { q: "ayúdame con la arquitectura de JARVIS", want: ["tesis"] },
  { q: "cómo preparo mi café", want: ["cafe"] },
  { q: "when is my dentist appointment", want: ["dentista"] },
  { q: "how is my brother doing in Toronto", want: ["hermano"] },
  { q: "which monitor arm fits my ultrawide", want: ["escritorio"] },
  { q: "suggest a book similar to my favorite", want: ["libro"] },
  { q: "give me a training plan for my half marathon", want: ["maraton"] },
  { q: "how do I reset my router", want: ["router"] },
  { q: "ideas para el cumpleaños de mi hija", want: ["hija"], also: ["cumple"] },
  { q: "cuántos GB me quedan en mi plan", want: ["plan"] },
  { q: "cada cuánto debo llevar mi bicicleta al taller", want: ["bici"] },
  { q: "qué hace mi hermana Ana los domingos", want: ["hermana"] },
  { q: "dime algo bonito para mi mamá", want: ["mama"] },
  { q: "recomiéndame música para correr", want: ["hobby"], also: ["maraton"] },
  // semantic gaps: the answer needs a memory that shares no word with the question
  { q: "puedo pedir ceviche esta noche", want: ["alergia"], hard: "semantic-gap" },
  { q: "dame un ejemplo de código en el lenguaje que más uso", want: ["codigo"], hard: "semantic-gap" },
  { q: "cuál es mi idioma nativo para traducir esto", want: ["idioma"], hard: "semantic-gap" },
  { q: "recomiéndame un plato típico para cocinar hoy", want: ["comida"], hard: "semantic-gap" },

  // ---- none: general knowledge and tasks that need nothing about the user ----
  ...[
    "cuál es la capital de Francia",
    "explícame qué es un closure en JavaScript",
    "cómo se llama la capital de Colombia",
    "cuál es el nombre del presidente de Francia",
    "qué hora es",
    "traduce hello world al español",
    "what is the speed of light",
    "how do I center a div in CSS",
    "write a haiku about the sea",
    "cuánto es 17 por 23",
    "dime un chiste",
    "qué es la fotosíntesis",
    "who won the 2018 world cup",
    "explain recursion with an example",
    "cuál es la diferencia entre TCP y UDP",
    "cómo funciona un motor de combustión",
    "qué significa la palabra efímero",
    "recomiéndame una película de ciencia ficción",
    "cómo se llama el director de Titanic",
    "resume la historia de Roma en tres frases",
    "what is the capital of Japan",
    "explica la diferencia entre let y const",
    "cuántos días tiene un año bisiesto",
    "qué es una API REST",
    "dame una receta de arepas",
    "how many bits are in a byte",
    "cuál es el planeta más grande del sistema solar",
    "quién escribió Don Quijote",
    "give me three tips for a job interview",
    "cómo se calcula el área de un círculo",
    "explícame qué es la inflación",
    "write a sql query to count rows in a table",
    "qué es el machine learning",
    "cómo se dice good morning en francés",
    "recomiéndame un libro de historia universal",
    "cuál es el río más largo del mundo",
    "how does a neural network learn",
    "ayúdame a escribir una carta de renuncia",
    "qué pasó en la revolución francesa",
    "cuánto tarda la luz del sol en llegar a la tierra",
  ].map((q): MemoryQuerySpec => ({ q, want: [] })),
  // hard negatives: they use a memory's topic word in another sense
  { q: "cómo se dice hermana en inglés", want: [], hard: "hard-negative" },
  { q: "cuál es el origen de la palabra gato", want: [], hard: "hard-negative" },
  { q: "qué es una bandeja de entrada en un correo", want: [], hard: "hard-negative" },
  { q: "explica la paradoja del cumpleaños", want: [], hard: "hard-negative" },
  { q: "cómo funciona el router de un framework web", want: [], hard: "hard-negative" },
  { q: "qué es un plan de negocios", want: [], hard: "hard-negative" },
];
