import { OverlayMessageFixture } from './overlay-message-sequence-analysis';
export type RedactionCategory = 'account' | 'transaction' | 'authentication';
export interface PrivacyInspection { path: string; category: RedactionCategory; valuePresent: boolean; }
export interface PrivacyReport { inspections: PrivacyInspection[]; preview: boolean; redacted: boolean; messages: OverlayMessageFixture[]; }
const FIELD_CATEGORIES: Record<string, RedactionCategory> = { account: 'account', accountId: 'account', peerId: 'account', nodeId: 'account', transaction: 'transaction', transactionEnvelope: 'transaction', txHash: 'transaction', auth: 'authentication', authCert: 'authentication', signature: 'authentication', nonce: 'authentication' };
function walk(value: unknown, path: string, categories: Set<RedactionCategory>, findings: PrivacyInspection[], redact: boolean): unknown {
  if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}[${index}]`, categories, findings, redact));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
    const category = FIELD_CATEGORIES[key];
    if (category && categories.has(category)) { findings.push({ path: `${path}.${key}`, category, valuePresent: child !== undefined && child !== null }); return [key, redact ? `[REDACTED:${category.toUpperCase()}]` : child]; }
    return [key, walk(child, `${path}.${key}`, categories, findings, redact)];
  }));
}
/** Returns cloned report data; fixture input objects are never modified. */
export function inspectOverlayPrivacy(messages: OverlayMessageFixture[], categories: RedactionCategory[] = ['account', 'transaction', 'authentication'], preview = false): PrivacyReport {
  const selected = new Set(categories); const inspections: PrivacyInspection[] = [];
  const sanitized = messages.map((message, index) => walk(message, `messages[${index}]`, selected, inspections, !preview) as OverlayMessageFixture);
  return { inspections, preview, redacted: !preview && inspections.length > 0, messages: sanitized };
}
