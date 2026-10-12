export const PASSWORD_MIN_LENGTH = 10;

/**
 * Returns a human-readable problem with the password, or null when acceptable.
 * Length matters most; we additionally reject trivially guessable inputs.
 */
export function checkPasswordStrength(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > 256) return "Use at most 256 characters.";
  if (isRepeatedGrapheme(password)) return "Avoid repeating a single character.";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (password.length < 16 && classes < 2) {
    return "Mix letters with numbers or symbols, or use a passphrase of 16+ characters.";
  }
  const lowered = password.toLowerCase();
  const common = ["password", "talorys", "qwerty", "123456", "letmein", "iloveyou", "admin"];
  if (common.some((c) => lowered.includes(c)) && password.length < 16) {
    return "Avoid common words such as 'password'.";
  }
  return null;
}

function isRepeatedGrapheme(password: string): boolean {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter();
    const graphemes = Array.from(segmenter.segment(password), (s) => s.segment);
    return graphemes.length > 0 && graphemes.every((g) => g === graphemes[0]);
  }
  return /^(.)\1+$/su.test(password);
}
