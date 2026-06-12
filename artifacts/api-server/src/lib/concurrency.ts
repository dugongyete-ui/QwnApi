/**
 * Concurrency limiter for Python subprocess calls.
 *
 * Limits the number of simultaneous Python processes to MAX_CONCURRENT.
 * Excess requests are queued (up to MAX_QUEUE). Requests that wait longer
 * than QUEUE_TIMEOUT_MS are rejected with a 503.
 */

const MAX_CONCURRENT = 20;
const MAX_QUEUE = 80;
const QUEUE_TIMEOUT_MS = 30_000;

let active = 0;

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const queue: QueueEntry[] = [];

function next() {
  if (queue.length === 0 || active >= MAX_CONCURRENT) return;
  const entry = queue.shift()!;
  clearTimeout(entry.timer);
  active++;
  entry.resolve();
}

/**
 * Acquire a slot. Waits if all slots are busy.
 * Throws if the queue is full or the request times out.
 */
export function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }

  if (queue.length >= MAX_QUEUE) {
    return Promise.reject(
      Object.assign(new Error("Gateway overloaded. Please retry later."), { code: "OVERLOADED" })
    );
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = queue.findIndex((e) => e.timer === timer);
      if (idx !== -1) queue.splice(idx, 1);
      reject(Object.assign(new Error("Request queued too long. Please retry later."), { code: "QUEUE_TIMEOUT" }));
    }, QUEUE_TIMEOUT_MS);

    queue.push({ resolve, reject, timer });
  });
}

/**
 * Release a slot and unblock the next queued request.
 */
export function release(): void {
  active--;
  next();
}

/**
 * Run a function inside a concurrency slot.
 * Automatically releases the slot when done (or on error).
 */
export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

export function getConcurrencyStats() {
  return { active, queued: queue.length, maxConcurrent: MAX_CONCURRENT, maxQueue: MAX_QUEUE };
}
