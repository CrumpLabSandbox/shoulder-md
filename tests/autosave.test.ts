import { describe, it, expect, vi } from 'vitest';
import { createAutosave, attachFlushTriggers } from '../src/persist/autosave';

describe('createAutosave', () => {
  it('debounces to the latest value', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const a = createAutosave<string>({ save, delayMs: 100 });
    a.schedule('a');
    a.schedule('ab');
    a.schedule('abc');
    expect(a.status).toBe('dirty');
    await vi.advanceTimersByTimeAsync(99);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('abc');
    expect(a.status).toBe('saved');
    vi.useRealTimers();
  });

  it('flush writes immediately', async () => {
    const save = vi.fn(async () => {});
    const a = createAutosave<string>({ save, delayMs: 10_000 });
    a.schedule('x');
    await a.flush();
    expect(save).toHaveBeenCalledWith('x');
    expect(a.status).toBe('saved');
    expect(a.lastSavedAt).toBeInstanceOf(Date);
  });

  it('serializes concurrent writes and keeps the newest', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const save = vi.fn(async (v: string) => {
      order.push(`start ${v}`);
      if (v === 'first') await new Promise<void>((r) => (release = r));
      order.push(`end ${v}`);
    });
    const a = createAutosave<string>({ save, delayMs: 1 });
    a.schedule('first');
    const f1 = a.flush();
    a.schedule('second');
    a.schedule('third');
    const f2 = a.flush();
    release!();
    await Promise.all([f1, f2]);
    expect(order).toEqual(['start first', 'end first', 'start third', 'end third']);
  });

  it('reports errors and retries on the next flush', async () => {
    let fail = true;
    const statuses: string[] = [];
    const save = vi.fn(async () => {
      if (fail) throw new Error('quota');
    });
    const a = createAutosave<string>({ save, delayMs: 1, onStatus: (s) => statuses.push(s) });
    a.schedule('v');
    await a.flush();
    expect(a.status).toBe('error');
    expect(a.lastError).toBeInstanceOf(Error);
    fail = false;
    await a.flush();
    expect(a.status).toBe('saved');
    expect(save).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(['dirty', 'saving', 'error', 'saving', 'saved']);
  });
});

describe('attachFlushTriggers', () => {
  it('flushes on blur, hidden, pagehide, and beforeunload', () => {
    const flush = vi.fn(async () => {});
    const detach = attachFlushTriggers(flush, window);
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(flush).toHaveBeenCalledTimes(4);
    detach();
    window.dispatchEvent(new Event('blur'));
    expect(flush).toHaveBeenCalledTimes(4);
  });
});

describe('createAutosave with merge', () => {
  it('accumulates scheduled values into one write', async () => {
    const save = vi.fn(async (_batch: number[]) => void _batch);
    const a = createAutosave<number[]>({ save, delayMs: 10_000, merge: (p, n) => [...p, ...n] });
    a.schedule([1]);
    a.schedule([2, 3]);
    await a.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('keeps order across a failed write and a retry', async () => {
    let fail = true;
    const save = vi.fn(async (_batch: number[]) => {
      void _batch;
      if (fail) throw new Error('nope');
    });
    const a = createAutosave<number[]>({ save, delayMs: 10_000, merge: (p, n) => [...p, ...n] });
    a.schedule([1]);
    await a.flush();
    a.schedule([2]);
    fail = false;
    await a.flush();
    expect(save).toHaveBeenLastCalledWith([1, 2]);
  });
});
