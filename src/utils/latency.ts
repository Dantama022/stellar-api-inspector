/**
 * Measures the elapsed time of an async operation in milliseconds.
 */
export async function measureLatency<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; latencyMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, latencyMs: Date.now() - start };
}
