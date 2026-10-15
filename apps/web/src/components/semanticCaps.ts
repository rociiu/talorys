/** A daily embedding cap the server accepts: an integer from 0 (off) to 10,000. */
export function isValidCap(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 10_000;
}
