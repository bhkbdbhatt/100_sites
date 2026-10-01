/**
 * Prompt sanitization. Two independent jobs, both required before any prompt
 * text leaves the process boundary:
 *
 *   1. redactSecrets / redactPii (FR-A2, NFR-A18) - credentials, tokens and
 *      personal data must never reach a model provider or a log sink.
 *   2. neutralizeInjection (FR-A3, NFR-A15) - the prompt is *data*, not
 *      instructions. Text attempting to alter system policy, widen build
 *      constraints or emit executable content is neutralized, and the sanitized
 *      remainder is still compiled.
 */

export type RedactionKind =
  | "email"
  | "phone"
  | "api_key"
  | "bearer_token"
  | "aws_key"
  | "private_key"
  | "jwt"
  | "password"
  | "url_credentials"
  | "ip_address";

export interface Redaction {
  kind: RedactionKind;
  placeholder: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
  total: number;
}

const PLACEHOLDER: Record<RedactionKind, string> = {
  email: "[REDACTED_EMAIL]",
  phone: "[REDACTED_PHONE]",
  api_key: "[REDACTED_SECRET]",
  bearer_token: "[REDACTED_TOKEN]",
  aws_key: "[REDACTED_AWS_KEY]",
  private_key: "[REDACTED_PRIVATE_KEY]",
  jwt: "[REDACTED_JWT]",
  password: "[REDACTED_PASSWORD]",
  url_credentials: "[REDACTED_URL_CREDENTIALS]",
  ip_address: "[REDACTED_IP]",
};

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  /** Only treat a match as a secret when Shannon entropy is at least this. */
  minEntropy?: number;
}

const RULES: Rule[] = [
  { kind: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "bearer_token", pattern: /\b(?:bearer|authorization:\s*bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
  { kind: "aws_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "api_key", pattern: /\b(?:sk|pk|rk|key|token|secret)[-_][A-Za-z0-9]{16,}\b/gi, minEntropy: 3 },
  {
    kind: "password",
    pattern: /\b(?:password|passwd|pwd|api[_-]?key|secret)\s*[:=]\s*["']?([^\s"']{6,})["']?/gi,
  },
  { kind: "url_credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
  { kind: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    kind: "phone",
    pattern: /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?(?![\w.])/g,
  },
  {
    kind: "ip_address",
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
];

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function looksHighEntropy(value: string, threshold = 3): boolean {
  if (value.length < 12) return false;
  return shannonEntropy(value) >= threshold;
}

/** Replaces secrets and PII with typed placeholders. Never throws. */
export function redact(input: string, options: { includePii?: boolean } = {}): RedactionResult {
  const { includePii = true } = options;
  let text = input;
  const tally = new Map<RedactionKind, number>();

  for (const rule of RULES) {
    const isPii = rule.kind === "email" || rule.kind === "phone" || rule.kind === "ip_address";
    if (isPii && !includePii) continue;
    text = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      // `String.replace` passes offset then the input string when the pattern
      // has no capture group, so the first extra argument is only a capture
      // group when it is actually a string.
      const capture = rest.find((value): value is string => typeof value === "string");
      if (rule.minEntropy !== undefined) {
        const candidate = capture ?? match;
        if (!looksHighEntropy(candidate, rule.minEntropy)) return match;
      }
      tally.set(rule.kind, (tally.get(rule.kind) ?? 0) + 1);
      return PLACEHOLDER[rule.kind];
    });
  }

  const redactions = [...tally.entries()].map(([kind, count]) => ({
    kind,
    count,
    placeholder: PLACEHOLDER[kind],
  }));

  return { text, redactions, total: redactions.reduce((sum, entry) => sum + entry.count, 0) };
}

export interface InjectionFinding {
  category: InjectionCategory;
  evidence: string;
  span: [number, number];
}

export type InjectionCategory =
  | "policy_override"
  | "constraint_widening"
  | "output_format_override"
  | "executable_content"
  | "delimiter_escape"
  | "data_exfiltration"
  | "tool_coercion";

interface InjectionRule {
  category: InjectionCategory;
  pattern: RegExp;
  replacement: string;
}

const INJECTION_RULES: InjectionRule[] = [
  {
    category: "policy_override",
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass|turn\s+off|disable)\b[^.\n]{0,48}\b(?:previous|prior|above|all|any|system|earlier)\b[^.\n]{0,24}\b(?:instruction|instructions|prompt|rule|rules|guard|guardrail|policy|policies|constraint|constraints)\b/gi,
    replacement: "[REMOVED_DIRECTIVE]",
  },
  {
    category: "policy_override",
    pattern: /\byou\s+are\s+now\b[^.\n]{0,60}\b(?:dan|developer\s+mode|unrestricted|jailbroken|no\s+longer\s+bound)\b/gi,
    replacement: "[REMOVED_DIRECTIVE]",
  },
  {
    category: "constraint_widening",
    pattern:
      /\b(?:allow|permit|enable|include|add|use)\b[^.\n]{0,32}\b(?:external\s+(?:javascript|js|script|scripting)|inline\s+script|eval|arbitrary\s+html|raw\s+html|third[-\s]party\s+scripts?)\b/gi,
    replacement: "[REMOVED_DIRECTIVE]",
  },
  {
    category: "constraint_widening",
    pattern: /\b(?:set|change|raise|remove|ignore)\b[^.\n]{0,32}\b(?:max_pages|budget|budgets|max_bundle_kb|allow_external_js|trailing_slash|constraints?)\b\s*(?:to|=|:|is)\s*[^\s,.;]*/gi,
    replacement: "[REMOVED_DIRECTIVE]",
  },
  {
    category: "output_format_override",
    pattern: /\b(?:respond|reply|answer|output|return|emit)\b[^.\n]{0,32}\b(?:with|in)\b[^.\n]{0,24}\b(?:raw|markdown|yaml|xml|non[-\s]json|plain\s+text)\b/gi,
    replacement: "[REMOVED_DIRECTIVE]",
  },
  {
    category: "executable_content",
    pattern: /<\s*(?:script|iframe|object|embed|svg\s+onload)\b[^>]*>/gi,
    replacement: "[REMOVED_MARKUP]",
  },
  {
    category: "executable_content",
    pattern: /\bon(?:error|load|click|mouseover|focus|submit)\s*=\s*["'][^"']*["']/gi,
    replacement: "[REMOVED_MARKUP]",
  },
  {
    category: "executable_content",
    pattern: /javascript\s*:/gi,
    replacement: "[REMOVED_MARKUP]",
  },
  {
    category: "delimiter_escape",
    pattern: /(?:^|\n)\s*(?:```|<\|im_start\|>|<\|im_end\|>|\[\/?INST\]|###\s*(?:system|assistant))/gi,
    replacement: "\n[REMOVED_DELIMITER]",
  },
  {
    category: "data_exfiltration",
    pattern: /\b(?:send|post|exfiltrate|upload|email|leak)\b[^.\n]{0,32}\b(?:api[\s_-]?key|secret|token|password|credentials?|env(?:ironment)?\s+variables?)\b[^.\n]{0,32}\b(?:to|at|toward|towards)\b/gi,
    replacement: "[REMOVED_DIRECTIVE]",
  },
  {
    category: "tool_coercion",
    pattern: /\b(?:call|invoke|execute|run)\b[^.\n]{0,24}\b(?:curl|wget|bash|sh|powershell|rm\s+-|drop\s+table|os\.system|subprocess)\b/gi,
    replacement: "[REMOVED_DIRECTIVE]",
  },
];

export interface InjectionResult {
  text: string;
  findings: InjectionFinding[];
  /** True when nothing was neutralized. */
  clean: boolean;
}

/**
 * Neutralizes instruction-shaped text inside the prompt. Offending spans are
 * replaced with inert markers rather than deleted, so the compiler can still
 * emit a useful site and the audit trail retains evidence of what was removed.
 */
export function neutralizeInjection(input: string): InjectionResult {
  let text = input;
  const findings: InjectionFinding[] = [];

  for (const rule of INJECTION_RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (match: string, offset: number) => {
      findings.push({
        category: rule.category,
        evidence: match.slice(0, 120),
        span: [offset, offset + match.length],
      });
      return rule.replacement;
    });
  }

  return { text, findings, clean: findings.length === 0 };
}

export interface SanitizeResult {
  text: string;
  redacted: RedactionResult;
  injection: InjectionResult;
  /** Convenience flags for the compiler's provenance block. */
  safe: boolean;
}

/** redact -> neutralize, in that order: directive text can carry credentials. */
export function sanitizePrompt(input: string): SanitizeResult {
  const redacted = redact(input);
  const injection = neutralizeInjection(redacted.text);
  return {
    text: injection.text,
    redacted,
    injection,
    safe: injection.clean,
  };
}

export const REDACTION_PLACEHOLDERS = PLACEHOLDER;
