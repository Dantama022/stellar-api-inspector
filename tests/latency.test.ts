import { measureLatency } from '../src/utils/latency';

describe('Latency measurement', () => {
  it('measures elapsed time for async operations', async () => {
    const { result, latencyMs } = await measureLatency(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'done';
    });

    expect(result).toBe('done');
    expect(latencyMs).toBeGreaterThanOrEqual(5);
  });
});
