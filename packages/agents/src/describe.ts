/** Spanish, human progress lines from either agent's tool calls ("Editando sum.js", "Ejecutando npm test"). */
const short = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const base = (p: unknown): string => (typeof p === "string" ? p.split(/[\\/]/).pop() ?? p : "");

export function describeTool(name: string, input: Record<string, unknown> = {}): { stage: string; file?: string } {
  const file = (input.file_path ?? input.path ?? input.absolute_path ?? input.notebook_path) as string | undefined;
  const n = name.toLowerCase();
  if (/^(read|read_file|read_many_files|view)$/.test(n)) return { stage: `Leyendo ${base(file) || "archivos"}` };
  if (/^(edit|multiedit|write|write_file|replace|notebookedit|str_replace_based_edit_tool)$/.test(n)) return { stage: `Editando ${base(file) || "archivos"}`, ...(file ? { file } : {}) };
  if (/^(bash|run_shell_command|shell)$/.test(n)) return { stage: `Ejecutando ${short(String(input.command ?? "un comando"))}` };
  if (/^(glob|grep|search_file_content|list_directory|ls|find)$/.test(n)) return { stage: "Buscando en el proyecto" };
  if (/^(webfetch|web_fetch|websearch|google_web_search)$/.test(n)) return { stage: "Consultando la web" };
  if (/^(todowrite|update_topic|write_todos)$/.test(n)) return { stage: "Planificando" };
  if (/^(task|invoke_agent)$/.test(n)) return { stage: "Delegando una subtarea" };
  return { stage: `Usando ${name}` };
}
