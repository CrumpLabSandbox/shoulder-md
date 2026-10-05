<script lang="ts">
  import type { SaveStatus } from '../persist/autosave';
  import { countWords } from '../preview/render';
  import { formatTime } from '../util/time';

  let {
    text,
    saveStatus,
    lastSavedAt,
    saveError,
  }: {
    text: string;
    saveStatus: SaveStatus;
    lastSavedAt: number | undefined;
    saveError?: string;
  } = $props();

  const words = $derived(countWords(text));
  const chars = $derived(text.length);

  const label = $derived.by(() => {
    switch (saveStatus) {
      case 'saved':
        return lastSavedAt ? `Saved ${formatTime(lastSavedAt)}` : 'Saved';
      case 'dirty':
        return 'Unsaved changes';
      case 'saving':
        return 'Saving…';
      case 'error':
        return 'Save failed';
    }
  });
</script>

<footer class="statusbar no-print">
  <span
    class="save status-{saveStatus}"
    title={saveError ?? "Documents save automatically to this browser's storage"}
  >
    <span class="dot"></span>{label}
  </span>
  <span class="counts">{words.toLocaleString()} words · {chars.toLocaleString()} characters</span>
</footer>

<style>
  .statusbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 12px;
    border-top: 1px solid var(--border);
    background: var(--bg-elev);
    color: var(--fg-muted);
    font-size: 12px;
    user-select: none;
  }
  .save {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--fg-faint);
  }
  .status-saved .dot {
    background: #16a34a;
  }
  .status-dirty .dot,
  .status-saving .dot {
    background: #d97706;
  }
  .status-error {
    color: var(--danger);
  }
  .status-error .dot {
    background: var(--danger);
  }
</style>
