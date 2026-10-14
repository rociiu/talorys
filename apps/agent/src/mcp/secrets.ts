/** Redacts reflected secrets in decoded strings, including JSON keys, before persistence. */
export function redactSecrets(text: string, secrets: string[]): string {
  for (const secret of secrets) text = text.split(secret).join("[secret omitted]");
  return text;
}
export function redactData(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactData(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSecrets(key, secrets), redactData(item, secrets)]));
  return value;
}
