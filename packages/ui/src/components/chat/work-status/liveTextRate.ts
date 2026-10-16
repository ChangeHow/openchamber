const BUCKET_MS = 1000;
const WINDOW_BUCKETS = 5;

/** Arrival throughput only. No history, provider timing, or inferred generation intervals. */
export const createLiveTextRateSampler = () => {
  let startedAt: number | null = null;
  // Five completed buckets plus the bucket currently receiving text.
  const buckets = Array.from({ length: WINDOW_BUCKETS + 1 }, () => ({ index: -1, tokens: 0 }));

  return {
    observe(delta: string, now: number): void {
      if (!delta) return;
      startedAt ??= now;
      const index = Math.floor((now - startedAt) / BUCKET_MS);
      const bucket = buckets[index % buckets.length];
      if (bucket.index !== index) {
        bucket.index = index;
        bucket.tokens = 0;
      }
      // Additive across chunks: CJK BMP characters count as one estimated
      // token; other UTF-16 code units count as a quarter, including whitespace.
      for (let i = 0; i < delta.length; i += 1) {
        const code = delta.charCodeAt(i);
        const cjk = (code >= 0x2e80 && code <= 0x9fff)
          || (code >= 0xac00 && code <= 0xd7af)
          || (code >= 0xf900 && code <= 0xfaff)
          || (code >= 0xff00 && code <= 0xffef);
        bucket.tokens += cjk ? 1 : 0.25;
      }
    },
    read(now: number): number | null {
      if (startedAt === null) return null;
      const completed = Math.floor((now - startedAt) / BUCKET_MS);
      if (completed < 1) return null;
      let tokens = 0;
      for (const bucket of buckets) {
        if (bucket.index >= Math.max(0, completed - WINDOW_BUCKETS) && bucket.index < completed) {
          tokens += bucket.tokens;
        }
      }
      return tokens / Math.min(completed, WINDOW_BUCKETS);
    },
  };
};
