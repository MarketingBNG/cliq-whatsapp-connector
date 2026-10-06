// Hides secrets and personal identifiers in chat text before Claude sees it.
// Claude only gets the real values when it calls a tool with reveal_sensitive=true, which the tool
// descriptions say requires the user's explicit permission first.

type Rule = { label: string; re: RegExp; keepGroup?: number; check?: (m: string) => boolean };

const luhn = (s: string) => {
  const d = s.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
};

const entropy = (s: string) => {
  const f = new Map<string, number>();
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let e = 0;
  for (const n of f.values()) e -= (n / s.length) * Math.log2(n / s.length);
  return e;
};

// Order matters: specific formats first, generic catch-alls last.
const RULES: Rule[] = [
  { label: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: "AWS key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "API key", re: /\b(?:sk|rk|pk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}\b/g },
  { label: "Zoho token", re: /\b1000\.[a-f0-9]{32}\.[a-f0-9]{32}\b/g },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi },
  { label: "password in URL", re: /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi },
  // "password: hunter2", "api key = abc", "OTP is 482913": keep the label, hide the value.
  {
    label: "credential",
    re: /\b(pass(?:word|wd|code)?|pwd|secret|api[ _-]?key|(?:access|refresh|auth)?[ _-]?token|client[ _-]?secret|otp|pin)(\s*[:=]\s*|\s+is\s+)("[^"]+"|'[^']+'|\S+)/gi,
    keepGroup: 3,
  },
  { label: "card number", re: /\b(?:\d[ -]?){12,18}\d\b/g, check: luhn },
  { label: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: "PAN", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { label: "Aadhaar", re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  // Unlabelled long random-looking strings (e.g. a pasted client secret).
  {
    label: "secret",
    re: /(?<![\w/.:-])[A-Za-z0-9_+/=-]{32,}(?![\w/.-])/g,
    check: (m) => /[A-Za-z]/.test(m) && /\d/.test(m) && entropy(m) > 3.5,
  },
];

export interface Redaction {
  text: string;
  found: Record<string, number>;
}

export function redact(text: string): Redaction {
  const found: Record<string, number> = {};
  let out = text;
  for (const r of RULES) {
    out = out.replace(r.re, (...args) => {
      const match = args[0] as string;
      if (match.includes("[REDACTED")) return match;
      if (r.keepGroup) {
        const value = args[r.keepGroup] as string;
        if (value.startsWith("[REDACTED") || value.length < 3) return match;
        found[r.label] = (found[r.label] ?? 0) + 1;
        return match.slice(0, match.length - value.length) + `[REDACTED: ${r.label}]`;
      }
      if (r.check && !r.check(match)) return match;
      found[r.label] = (found[r.label] ?? 0) + 1;
      return `[REDACTED: ${r.label}]`;
    });
  }
  return { text: out, found };
}

// Apply to a list of messages; returns the cleaned list plus a combined count by type.
export function redactAll<T extends { text: string }>(items: T[], reveal: boolean): { items: T[]; found: Record<string, number> } {
  if (reveal) return { items, found: {} };
  const found: Record<string, number> = {};
  const cleaned = items.map((m) => {
    const r = redact(m.text);
    for (const [k, v] of Object.entries(r.found)) found[k] = (found[k] ?? 0) + v;
    return { ...m, text: r.text };
  });
  return { items: cleaned, found };
}

export function redactionNotice(found: Record<string, number>): string {
  const total = Object.values(found).reduce((a, b) => a + b, 0);
  if (!total) return "";
  const kinds = Object.entries(found).map(([k, v]) => `${v} ${k}`).join(", ");
  return (
    `SENSITIVE DATA HIDDEN: ${total} value(s) were redacted (${kinds}). ` +
    `Do not guess or reconstruct them. Tell the user that credentials were shared in plain text and should be rotated. ` +
    `Only if the user explicitly asks to see them, and confirms after being warned, call the tool again with reveal_sensitive=true.`
  );
}
