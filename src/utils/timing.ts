export interface TimingBreakdown {
  accountFetchMs: number;
  buildMs: number;
  submissionMs: number;
  responseProcessingMs: number;
  totalMs: number;
}

export function createTimingBreakdown(
  accountFetchMs: number,
  buildMs: number,
  submissionMs: number,
  responseProcessingMs: number,
): TimingBreakdown {
  return {
    accountFetchMs,
    buildMs,
    submissionMs,
    responseProcessingMs,
    totalMs: accountFetchMs + buildMs + submissionMs + responseProcessingMs,
  };
}

export function now(): number {
  return Date.now();
}

export function elapsed(start: number): number {
  return Date.now() - start;
}
