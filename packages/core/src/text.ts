/** Lowercase, accent-free, punctuation-free form used to compare spoken/typed text and aliases. */
export const normalizeText = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿?¡!.,]/g, "")
    .trim();
