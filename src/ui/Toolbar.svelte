<script lang="ts">
  import type { Layout } from '../settings/settings.svelte';

  let {
    title,
    layout,
    docsOpen,
    settingsOpen,
    onrename,
    onlayout,
    ontoggledocs,
    ontogglesettings,
  }: {
    title: string;
    layout: Layout;
    docsOpen: boolean;
    settingsOpen: boolean;
    onrename: (title: string) => void;
    onlayout: (layout: Layout) => void;
    ontoggledocs: () => void;
    ontogglesettings: () => void;
  } = $props();

  const layouts: { id: Layout; label: string; hint: string }[] = [
    { id: 'editor', label: 'Write', hint: 'Editor only' },
    { id: 'split', label: 'Split', hint: 'Editor and preview (⌘⇧E)' },
    { id: 'preview', label: 'Preview', hint: 'Rendered Markdown (⌘E)' },
  ];
</script>

<header class="toolbar no-print">
  <div class="left">
    <button
      class:active={docsOpen}
      onclick={ontoggledocs}
      title="Documents (⌘⇧D)"
      aria-label="Documents"
    >
      ☰
    </button>
    <input
      class="title"
      type="text"
      value={title}
      aria-label="Document title"
      onchange={(e) => onrename(e.currentTarget.value)}
      onkeydown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  </div>
  <div class="right">
    <div class="segmented" role="group" aria-label="Layout">
      {#each layouts as l (l.id)}
        <button class:active={layout === l.id} onclick={() => onlayout(l.id)} title={l.hint}
          >{l.label}</button
        >
      {/each}
    </div>
    <button
      class:active={settingsOpen}
      onclick={ontogglesettings}
      title="Settings (⌘,)"
      aria-label="Settings"
    >
      Aa
    </button>
  </div>
</header>

<style>
  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    user-select: none;
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .title {
    border: 1px solid transparent;
    background: transparent;
    font-weight: 600;
    min-width: 12ch;
    width: 32ch;
    max-width: 50vw;
    padding: 4px 6px;
  }
  .title:hover,
  .title:focus {
    border-color: var(--border);
    background: var(--bg);
  }
  .segmented {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .segmented button {
    border-radius: 0;
    border: 0;
    padding: 4px 10px;
  }
  .segmented button + button {
    border-left: 1px solid var(--border);
  }
</style>
