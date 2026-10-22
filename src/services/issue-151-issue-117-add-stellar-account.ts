export interface Issue117AddStellar151AuditInput {
  targetId: string;
  observedCount: number;
  anomalyCount: number;
  limitThreshold?: number;
}

export interface Issue117AddStellar151AuditResult {
  targetId: string;
  observedCount: number;
  anomalyCount: number;
  scoreBps: number;
  level: 'normal' | 'warning' | 'critical';
}

export function auditIssue117AddStellar151(input: Issue117AddStellar151AuditInput): Issue117AddStellar151AuditResult {
  const targetId = input.targetId.trim();
  if (!targetId) {
    throw new Error('auditIssue117AddStellar151: targetId is required');
  }
  const observedCount = Math.max(0, Math.trunc(input.observedCount));
  const anomalyCount = Math.max(0, Math.trunc(input.anomalyCount));
  const limit = Math.max(1, Math.trunc(input.limitThreshold ?? 100));
  const total = observedCount + anomalyCount * 2;
  const scoreBps = Math.min(10000, Math.round((total * 10000) / limit));

  let level: 'normal' | 'warning' | 'critical' = 'normal';
  if (scoreBps >= 8500) {
    level = 'critical';
  } else if (scoreBps >= 5000) {
    level = 'warning';
  }

  return {
    targetId,
    observedCount,
    anomalyCount,
    scoreBps,
    level,
  };
}
