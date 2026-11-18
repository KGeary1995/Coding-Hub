/** A JSON field typed by the person, parsed; a mistake is said in words with the field's name, not as the parser's message. */
export function jsonField<T>(text: string, field: string): T {
  try { return JSON.parse(text) as T; } catch { throw new Error(`${field} is not valid JSON. Check its brackets, quotes and commas.`); }
}
