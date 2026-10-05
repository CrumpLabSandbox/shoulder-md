/**
 * Debounced background saver with forced flushes.
 *
 * Every change is queued; the latest value is written after `delayMs` of quiet.
 * `flush()` writes immediately. The caller wires flush to blur, visibilitychange,
 * pagehide and beforeunload (see `attachFlushTriggers`), so a closed tab loses at
 * most what was typed in the last `delayMs`.
 */

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

export type Autosave<T> = {
  schedule(value: T): void;
  flush(): Promise<void>;
  readonly status: SaveStatus;
  readonly lastSavedAt: Date | undefined;
  readonly lastError: unknown;
  dispose(): void;
};

export type AutosaveOptions<T> = {
  save: (value: T) => Promise<void>;
  delayMs?: number;
  onStatus?: (status: SaveStatus) => void;
  /** Combines a queued value with a newly scheduled one. Default: the new value replaces the old. */
  merge?: (pending: T, next: T) => T;
};

export function createAutosave<T>(opts: AutosaveOptions<T>): Autosave<T> {
  const delayMs = opts.delayMs ?? 250;
  let pending: { value: T } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let status: SaveStatus = 'saved';
  let lastSavedAt: Date | undefined;
  let lastError: unknown;

  function setStatus(s: SaveStatus) {
    if (s !== status) {
      status = s;
      opts.onStatus?.(s);
    }
  }

  async function write(): Promise<void> {
    if (!pending) return;
    // If a write is already running, wait for it, then write the newest value.
    if (inFlight) {
      await inFlight;
      return write();
    }
    const { value } = pending;
    pending = undefined;
    setStatus('saving');
    inFlight = opts
      .save(value)
      .then(() => {
        lastSavedAt = new Date();
        lastError = undefined;
        setStatus(pending ? 'dirty' : 'saved');
      })
      .catch((err: unknown) => {
        lastError = err;
        // Keep the value so a later flush can retry, merged with anything queued meanwhile.
        pending = pending
          ? { value: opts.merge ? opts.merge(value, pending.value) : pending.value }
          : { value };
        setStatus('error');
      })
      .finally(() => {
        inFlight = undefined;
      });
    await inFlight;
  }

  return {
    schedule(value: T) {
      pending = pending && opts.merge ? { value: opts.merge(pending.value, value) } : { value };
      setStatus('dirty');
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void write();
      }, delayMs);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await write();
      if (inFlight) await inFlight;
    },
    get status() {
      return status;
    },
    get lastSavedAt() {
      return lastSavedAt;
    },
    get lastError() {
      return lastError;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Flushes on the events that precede a tab going away or losing focus. Returns a detach function. */
export function attachFlushTriggers(
  flush: () => Promise<void>,
  target: Window = window,
): () => void {
  const onHidden = () => {
    if (target.document.visibilityState === 'hidden') void flush();
  };
  const onFlush = () => void flush();
  target.addEventListener('blur', onFlush);
  target.document.addEventListener('visibilitychange', onHidden);
  target.addEventListener('pagehide', onFlush);
  target.addEventListener('beforeunload', onFlush);
  return () => {
    target.removeEventListener('blur', onFlush);
    target.document.removeEventListener('visibilitychange', onHidden);
    target.removeEventListener('pagehide', onFlush);
    target.removeEventListener('beforeunload', onFlush);
  };
}
