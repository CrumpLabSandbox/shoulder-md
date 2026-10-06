<script lang="ts">
  import type { SaveStatus } from '../persist/autosave';
  import { countWords } from '../preview/render';
  import { formatTime } from '../util/time';
  import type { FolderStatus } from '../docs/workspace.svelte';

  let {
    text,
    saveStatus,
    lastSavedAt,
    saveError,
    folder,
    onconnect,
    onreconnect,
  }: {
    text: string;
    saveStatus: SaveStatus;
    lastSavedAt: number | undefined;
    saveError?: string;
    folder: FolderStatus;
    onconnect: () => void;
    onreconnect: () => void;
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
  <span class="folder">
    {#if folder.status === 'none'}
      <button
        onclick={onconnect}
        title="Keep a .md and .shoulder.json copy of every document in a folder"
        >Save to a folder…</button
      >
    {:else if folder.status === 'connected'}
      <span
        class="synced"
        title="Every document is mirrored to “{folder.name}” as .md and .shoulder.json{folder.lastWrite
          ? `; last written ${formatTime(folder.lastWrite)}`
          : ''}"><span class="dot ok"></span>Folder: {folder.name}</span
      >
    {:else if folder.status === 'needs-permission'}
      <button
        class="warn"
        onclick={onreconnect}
        title="The browser needs your permission again to write to this folder"
        >Reconnect folder “{folder.name}”</button
      >
    {:else if folder.status === 'error'}
      <button class="warn" onclick={onreconnect} title={folder.error}
        >Folder error: retry “{folder.name}”</button
      >
    {/if}
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
  .folder button {
    font-size: 12px;
    padding: 1px 6px;
    color: var(--fg-muted);
  }
  .folder .warn {
    color: #b45309;
  }
  .synced {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dot.ok {
    background: #16a34a;
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
