<script lang="ts">
  import type { Workspace } from '../docs/workspace.svelte';

  let {
    ws,
    onaskclaude,
  }: {
    ws: Workspace;
    /** Opens the Ask Claude panel; only given in the Mac app. */
    onaskclaude?: () => void;
  } = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

  const meta = $derived(ws.current?.state.meta);
  const isGuide = $derived(!!meta?.guide);
  const genreName = $derived(ws.currentGenre?.title ?? '');
  /** What the genre alone would decide, shown on the "follow genre" choice. */
  const genreDefault = $derived(
    meta ? ws.claudeAllowed({ genre: meta.genre, guide: meta.guide }) : true,
  );
  const mode = $derived<'follow' | 'on' | 'off'>(
    meta?.claude === undefined ? 'follow' : meta.claude ? 'on' : 'off',
  );
  const destination = $derived.by(() => {
    if (ws.claudeOn) {
      return ws.folder.status === 'connected'
        ? `Files are written to the shared folder “${ws.folder.name}”, where Claude Code can read them.`
        : 'No shared folder is connected, so nothing is written to disk yet.';
    }
    const p = ws.privateFolder;
    return p.status === 'connected'
      ? `Files are written only to the private folder “${p.name}”.`
      : 'Files stay inside the app. Choose a private folder in the Library to keep a copy on disk.';
  });

  const ask = (message: string) => window.confirm(message);

  async function chooseGenre(e: Event & { currentTarget: HTMLSelectElement }) {
    const select = e.currentTarget;
    const id = ws.current?.id;
    if (!id) return;
    const ok = await ws.setGenre(id, select.value || null, ask);
    if (!ok) select.value = meta?.genre ?? '';
  }

  function chooseMode(m: 'follow' | 'on' | 'off') {
    const id = ws.current?.id;
    if (!id || m === mode) return;
    void ws.setClaude(id, m === 'follow' ? null : m === 'on', ask);
  }

  function onWindowClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window onclick={onWindowClick} />

<div class="access" bind:this={root}>
  <button
    class="trigger"
    class:active={open}
    class:off={!ws.claudeOn}
    onclick={() => (open = !open)}
    title="Genre and Claude access"
    aria-expanded={open}
  >
    {#if isGuide}
      <span class="genre">{meta?.guide?.role === 'base' ? 'Base guide' : 'Genre guide'}</span>
    {:else if genreName}
      <span class="genre">{genreName}</span>
    {/if}
    <span class="dot"></span>{ws.claudeOn ? 'Claude on' : 'Claude off'}
  </button>
  {#if open && meta}
    <div class="panel" role="dialog" aria-label="Genre and Claude access">
      {#if !isGuide}
        <label class="row">
          <span class="label">Genre</span>
          <select value={meta.genre ?? ''} onchange={chooseGenre} aria-label="Genre">
            <option value="">None (base guide only)</option>
            {#each ws.genres as g (g.id)}
              <option value={g.id}>{g.title}{g.guide?.private ? ' (private)' : ''}</option>
            {/each}
            {#if meta.genre && !ws.genres.some((g) => g.id === meta.genre)}
              <option value={meta.genre}>Deleted genre</option>
            {/if}
          </select>
        </label>
      {/if}
      <div class="row">
        <span class="label">Claude</span>
        <div class="segmented" role="group" aria-label="Claude access">
          <button class:active={mode === 'follow'} onclick={() => chooseMode('follow')}
            >{isGuide ? 'Default' : 'Genre default'} ({genreDefault ? 'on' : 'off'})</button
          >
          <button class:active={mode === 'on'} onclick={() => chooseMode('on')}>On</button>
          <button class:active={mode === 'off'} onclick={() => chooseMode('off')}>Off</button>
        </div>
      </div>
      <p class="hint">{destination}</p>
      <div class="links">
        {#if onaskclaude && ws.claudeOn && !isGuide}
          <button
            onclick={() => {
              open = false;
              onaskclaude();
            }}>Ask Claude to suggest edits…</button
          >
        {/if}
        <button
          onclick={() => {
            open = false;
            void ws.openBaseGuide();
          }}>{ws.baseGuide ? 'Open the base guide' : 'Create the base guide'}</button
        >
        {#if ws.currentGenre}
          {@const g = ws.currentGenre}
          <button
            onclick={() => {
              open = false;
              void ws.open(g.id);
            }}>Open the “{g.title}” guide</button
          >
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .access {
    position: relative;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--border);
    white-space: nowrap;
  }
  .genre {
    font-weight: 600;
    max-width: 16ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .genre::after {
    content: '·';
    margin-left: 6px;
    font-weight: normal;
    color: var(--fg-muted);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #d97706;
  }
  .trigger.off .dot {
    background: var(--fg-faint);
  }
  .panel {
    position: absolute;
    right: 0;
    top: 100%;
    z-index: 6;
    width: 340px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .label {
    width: 4.5em;
    color: var(--fg-muted);
    font-size: 12px;
  }
  select {
    flex: 1;
    min-width: 0;
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
    padding: 3px 8px;
    font-size: 12px;
    white-space: nowrap;
  }
  .segmented button + button {
    border-left: 1px solid var(--border);
  }
  .hint {
    margin: 0;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .links button {
    border: 1px solid var(--border);
    font-size: 12px;
  }
</style>
