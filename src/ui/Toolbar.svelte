<script lang="ts">
  import type { Layout } from '../settings/settings.svelte';
  import type { View } from '../model/views';

  let {
    title,
    layout,
    view,
    trackingOn,
    pendingCount,
    docsOpen,
    marginOpen,
    settingsOpen,
    canUndo,
    canRedo,
    onrename,
    onlayout,
    onview,
    ontoggletracking,
    oncomment,
    ontoggledocs,
    ontogglemargin,
    ontogglesettings,
    onundo,
    onredo,
    onexport,
  }: {
    title: string;
    layout: Layout;
    view: View;
    trackingOn: boolean;
    pendingCount: number;
    docsOpen: boolean;
    marginOpen: boolean;
    settingsOpen: boolean;
    canUndo: boolean;
    canRedo: boolean;
    onrename: (title: string) => void;
    onlayout: (layout: Layout) => void;
    onview: (view: View) => void;
    ontoggletracking: () => void;
    oncomment: () => void;
    ontoggledocs: () => void;
    ontogglemargin: () => void;
    ontogglesettings: () => void;
    onundo: () => void;
    onredo: () => void;
    onexport: (kind: ExportKind) => void;
  } = $props();

  type ExportKind =
    'md-clean' | 'md-original' | 'md-critic' | 'json' | 'docx' | 'print-clean' | 'print-markup';
  let exportOpen = $state(false);
  const exports: { kind: ExportKind; label: string; hint: string }[] = [
    { kind: 'md-clean', label: 'Markdown (clean)', hint: 'All changes accepted' },
    { kind: 'md-original', label: 'Markdown (original)', hint: 'All changes rejected' },
    {
      kind: 'md-critic',
      label: 'Markdown with changes',
      hint: 'CriticMarkup: changes and comments marked up',
    },
    { kind: 'docx', label: 'Word (.docx)', hint: 'Real tracked changes and comments' },
    { kind: 'json', label: 'JSON (full history)', hint: 'Everything, including the op log' },
    { kind: 'print-clean', label: 'Print / PDF (clean)', hint: 'Browser print dialog' },
    {
      kind: 'print-markup',
      label: 'Print / PDF (with changes)',
      hint: 'Changes inline, comments as footnotes',
    },
  ];

  const layouts: { id: Layout; label: string; hint: string }[] = [
    { id: 'editor', label: 'Write', hint: 'Editor only' },
    { id: 'split', label: 'Split', hint: 'Editor and preview (⌘⇧E)' },
    { id: 'preview', label: 'Preview', hint: 'Rendered Markdown (⌘E)' },
  ];
  const views: { id: View; label: string; hint: string }[] = [
    { id: 'revision', label: 'Markup', hint: 'Show changes inline' },
    { id: 'clean', label: 'Clean', hint: 'All changes accepted (read-only)' },
    { id: 'original', label: 'Original', hint: 'All changes rejected (read-only)' },
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
    <button onclick={onundo} disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo">↶</button>
    <button onclick={onredo} disabled={!canRedo} title="Redo (⌘⇧Z)" aria-label="Redo">↷</button>
  </div>
  <div class="right">
    <button
      class="track"
      class:on={trackingOn}
      onclick={ontoggletracking}
      title="Track changes (⌘⌥T)"
      aria-pressed={trackingOn}
    >
      <span class="led"></span>Track changes
    </button>
    <button onclick={oncomment} title="Comment on the selection (⌘⌥C)" aria-label="Comment"
      >💬</button
    >
    <div class="segmented" role="group" aria-label="View">
      {#each views as v (v.id)}
        <button class:active={view === v.id} onclick={() => onview(v.id)} title={v.hint}
          >{v.label}</button
        >
      {/each}
    </div>
    <button
      class:active={marginOpen}
      onclick={ontogglemargin}
      title="Changes (⌘⌥M)"
      aria-label="Changes"
    >
      Changes{#if pendingCount > 0}<span class="badge">{pendingCount}</span>{/if}
    </button>
    <div class="segmented" role="group" aria-label="Layout">
      {#each layouts as l (l.id)}
        <button class:active={layout === l.id} onclick={() => onlayout(l.id)} title={l.hint}
          >{l.label}</button
        >
      {/each}
    </div>
    <div class="menu">
      <button
        class:active={exportOpen}
        onclick={() => (exportOpen = !exportOpen)}
        title="Export"
        aria-label="Export"
      >
        Export ▾
      </button>
      {#if exportOpen}
        <div class="dropdown" role="menu">
          {#each exports as e (e.kind)}
            <button
              title={e.hint}
              onclick={() => {
                exportOpen = false;
                onexport(e.kind);
              }}>{e.label}</button
            >
          {/each}
        </div>
      {/if}
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
    width: 28ch;
    max-width: 40vw;
    padding: 4px 6px;
  }
  .title:hover,
  .title:focus {
    border-color: var(--border);
    background: var(--bg);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
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
  .track {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--border);
  }
  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fg-faint);
  }
  .track.on {
    border-color: #16a34a;
    color: #15803d;
  }
  .track.on .led {
    background: #16a34a;
    box-shadow: 0 0 0 3px color-mix(in srgb, #16a34a 25%, transparent);
  }
  .menu {
    position: relative;
  }
  .dropdown {
    position: absolute;
    right: 0;
    top: 100%;
    z-index: 6;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    min-width: 220px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  }
  .dropdown button {
    text-align: left;
    white-space: nowrap;
  }
  .badge {
    margin-left: 5px;
    background: var(--accent);
    color: var(--accent-fg);
    border-radius: 999px;
    font-size: 11px;
    padding: 0 6px;
  }
</style>
