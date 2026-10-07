<script lang="ts">
  import type { Workspace } from '../docs/workspace.svelte';

  let {
    ws,
    ondraft,
  }: {
    ws: Workspace;
    /** Opens the panel that drafts principles from samples; only given in the Mac app. */
    ondraft?: () => void;
  } = $props();

  const guide = $derived(ws.currentGuide);
  const count = $derived(guide?.principles.length ?? 0);
  const waiting = $derived(guide?.unnumbered ?? 0);
  const replacing = $derived(guide?.principles.filter((p) => p.replaces).length ?? 0);
</script>

{#if guide}
  <div class="banner no-print" role="status">
    <span class="kind">{guide.role === 'base' ? 'Base style guide' : 'Genre guide'}</span>
    <span>
      {count}
      {count === 1 ? 'principle' : 'principles'} ({guide.prefix}…){#if replacing}, {replacing}
        replacing base principles{/if}{#if guide.private}. Private: Claude is off by default for
        documents in this genre{/if}.
    </span>
    {#if waiting}
      <span class="waiting">
        {waiting}
        {waiting === 1 ? 'new principle needs' : 'new principles need'} an id.
      </span>
      <button
        onclick={() => ws.numberPrinciples()}
        disabled={ws.view !== 'revision'}
        title="Adds the next free id to each top-level list item that has none"
        >Give {waiting === 1 ? 'it an id' : 'them ids'}</button
      >
    {/if}
    {#if ondraft && guide.role === 'genre'}
      <button
        onclick={ondraft}
        title="Have Claude Code read Style/Samples for this genre and suggest principles"
        >Draft principles from samples…</button
      >
    {/if}
    <span class="help"
      >Each top-level list item is a principle. Ids never change, so links from your edits stay put.</span
    >
  </div>
{/if}

<style>
  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    padding: 5px 12px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-elev));
  }
  .kind {
    font-weight: 600;
  }
  .waiting {
    color: #b45309;
  }
  button {
    border: 1px solid var(--border);
    font-size: 12px;
    padding: 2px 8px;
  }
  .help {
    color: var(--fg-muted);
    margin-left: auto;
  }
</style>
