<script lang="ts">
  import type { Workspace } from '../docs/workspace.svelte';
  import { authorName } from '../docs/identity';
  import ChangeCard from './ChangeCard.svelte';

  let {
    ws,
    measure,
    tick,
  }: {
    ws: Workspace;
    /** Viewport-relative top of a revision offset, from the editor. */
    measure: (pos: number) => number | undefined;
    /** Bumped when the editor scrolls, resizes, or changes, to re-measure. */
    tick: number;
  } = $props();

  const GAP = 6;
  let heights = $state<Record<string, number>>({});

  // Desired tops from the editor, then pushed down so cards never overlap.
  const tops = $derived.by(() => {
    void tick;
    const out: Record<string, number> = {};
    let floor = 0;
    for (const c of ws.pending) {
      const wanted = measure(c.from);
      if (wanted === undefined) {
        out[c.id] = -10_000;
        continue;
      }
      const top = Math.max(wanted, floor);
      out[c.id] = top;
      floor = top + (heights[c.id] ?? 80) + GAP;
    }
    return out;
  });

  const byAuthor = $derived.by(() => {
    const counts: Record<string, number> = {};
    for (const c of ws.pending) counts[c.author] = (counts[c.author] ?? 0) + 1;
    return Object.entries(counts);
  });

  let menuOpen = $state(false);
</script>

<aside class="margin no-print" aria-label="Changes">
  <div class="head">
    <span>{ws.pending.length} {ws.pending.length === 1 ? 'change' : 'changes'}</span>
    {#if ws.pending.length > 0}
      <div class="menu">
        <button onclick={() => (menuOpen = !menuOpen)} class:active={menuOpen}>All ▾</button>
        {#if menuOpen}
          <div class="dropdown" role="menu">
            <button
              onclick={() => {
                ws.acceptAll();
                menuOpen = false;
              }}>Accept all</button
            >
            <button
              onclick={() => {
                ws.rejectAll();
                menuOpen = false;
              }}>Reject all</button
            >
            {#if byAuthor.length > 1}
              <hr />
              {#each byAuthor as [id, n] (id)}
                <button
                  onclick={() => {
                    ws.accept(ws.pending.filter((c) => c.author === id).map((c) => c.id));
                    menuOpen = false;
                  }}
                >
                  Accept {authorName(id, ws.authors)} ({n})
                </button>
                <button
                  onclick={() => {
                    ws.reject(ws.pending.filter((c) => c.author === id).map((c) => c.id));
                    menuOpen = false;
                  }}
                >
                  Reject {authorName(id, ws.authors)} ({n})
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
  <div class="cards">
    {#each ws.pending as c (c.id)}
      <div
        class="slot"
        style:top="{tops[c.id] ?? -10000}px"
        bind:clientHeight={
          () => heights[c.id] ?? 0,
          (h) => {
            if (h && heights[c.id] !== h) heights = { ...heights, [c.id]: h };
          }
        }
      >
        <ChangeCard
          change={c}
          color={ws.colors[c.author] ?? 'var(--accent)'}
          name={authorName(c.author, ws.authors)}
          active={c.id === ws.activeChangeId}
          onaccept={() => ws.accept([c.id])}
          onreject={() => ws.reject([c.id])}
          onreason={(reason, tags) => ws.setReason(c.id, reason, tags)}
          onjump={() => ws.jumpTo(c.id)}
        />
      </div>
    {/each}
    {#if ws.pending.length === 0}
      <p class="empty">
        {#if ws.trackingOn}
          No pending changes. Edits you make now will show up here.
        {:else}
          Track changes is off. Turn it on (⌘⌥T) to record edits as changes.
        {/if}
      </p>
    {/if}
  </div>
</aside>

<style>
  .margin {
    width: 300px;
    flex: none;
    border-left: 1px solid var(--border);
    background: var(--bg-sunk);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 600;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .menu {
    position: relative;
  }
  .dropdown {
    position: absolute;
    right: 0;
    top: 100%;
    z-index: 5;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    min-width: 160px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  }
  .dropdown button {
    text-align: left;
    font-weight: 400;
    white-space: nowrap;
  }
  .dropdown hr {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 4px 0;
  }
  .cards {
    position: relative;
    flex: 1;
    overflow: hidden;
  }
  .slot {
    position: absolute;
    left: 0;
    right: 0;
  }
  .slot :global(.card) {
    position: relative;
    left: 8px;
    right: 8px;
    width: calc(100% - 16px);
    margin-top: 6px;
  }
  .empty {
    color: var(--fg-muted);
    font-size: 12px;
    padding: 12px;
    margin: 0;
  }
</style>
