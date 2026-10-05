<script lang="ts">
  import type { Workspace, Thread } from '../docs/workspace.svelte';
  import type { PendingChange } from '../model/changes';
  import { authorName } from '../docs/identity';
  import ChangeCard from './ChangeCard.svelte';
  import CommentCard from './CommentCard.svelte';
  import DraftCard from './DraftCard.svelte';

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

  type Item =
    | { key: string; kind: 'change'; from: number; change: PendingChange }
    | { key: string; kind: 'comment'; from: number; thread: Thread }
    | { key: string; kind: 'draft'; from: number };

  const GAP = 6;
  let heights = $state<Record<string, number>>({});

  // Changes, comment threads, and the draft composer, in document order. A thread that
  // discusses a change sorts right after that change.
  const items = $derived.by(() => {
    const out: Item[] = [];
    for (const c of ws.pending)
      out.push({ key: `c:${c.id}`, kind: 'change', from: c.from, change: c });
    for (const t of ws.threads) {
      const linked = t.changeId ? ws.pending.find((c) => c.id === t.changeId) : undefined;
      out.push({
        key: `t:${t.threadId}`,
        kind: 'comment',
        from: linked ? linked.from + 0.5 : t.from,
        thread: t,
      });
    }
    if (ws.draft) out.push({ key: 'draft', kind: 'draft', from: ws.draft.from - 0.25 });
    return out.sort((a, b) => a.from - b.from);
  });

  // Desired tops from the editor, then pushed down so cards never overlap.
  const tops = $derived.by(() => {
    void tick;
    const out: Record<string, number> = {};
    let floor = 0;
    for (const it of items) {
      const wanted = measure(Math.floor(it.from));
      if (wanted === undefined) {
        out[it.key] = -10_000;
        continue;
      }
      const top = Math.max(wanted, floor);
      out[it.key] = top;
      floor = top + (heights[it.key] ?? 80) + GAP;
    }
    return out;
  });

  const byAuthor = $derived.by(() => {
    const counts: Record<string, number> = {};
    for (const c of ws.pending) counts[c.author] = (counts[c.author] ?? 0) + 1;
    return Object.entries(counts);
  });

  const resolvedCount = $derived(ws.allThreads.filter((t) => t.resolved).length);
  const headline = $derived.by(() => {
    const n = ws.pending.length;
    const m = ws.allThreads.length - resolvedCount;
    return `${n} ${n === 1 ? 'change' : 'changes'} · ${m} ${m === 1 ? 'comment' : 'comments'}`;
  });
  let menuOpen = $state(false);
</script>

<aside class="margin no-print" aria-label="Changes and comments">
  <div class="head">
    <span>{headline}</span>
    <div class="menu">
      <button
        onclick={() => (menuOpen = !menuOpen)}
        class:active={menuOpen}
        aria-label="Margin menu">⋯</button
      >
      {#if menuOpen}
        <div class="dropdown" role="menu">
          {#if ws.pending.length > 0}
            <button
              onclick={() => {
                ws.acceptAll();
                menuOpen = false;
              }}>Accept all changes</button
            >
            <button
              onclick={() => {
                ws.rejectAll();
                menuOpen = false;
              }}>Reject all changes</button
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
            <hr />
          {/if}
          <label class="check">
            <input
              type="checkbox"
              checked={ws.showResolved}
              onchange={(e) => ws.setShowResolved(e.currentTarget.checked)}
            />
            Show resolved comments ({resolvedCount})
          </label>
        </div>
      {/if}
    </div>
  </div>
  <div class="cards">
    {#each items as it (it.key)}
      <div
        class="slot"
        style:top="{tops[it.key] ?? -10000}px"
        bind:clientHeight={
          () => heights[it.key] ?? 0,
          (h) => {
            if (h && heights[it.key] !== h) heights = { ...heights, [it.key]: h };
          }
        }
      >
        {#if it.kind === 'change'}
          <ChangeCard
            change={it.change}
            color={ws.colors[it.change.author] ?? 'var(--accent)'}
            name={authorName(it.change.author, ws.authors)}
            active={it.change.id === ws.activeChangeId}
            onaccept={() => ws.accept([it.change.id])}
            onreject={() => ws.reject([it.change.id])}
            onreason={(reason, tags) => ws.setReason(it.change.id, reason, tags)}
            onjump={() => ws.jumpTo(it.change.id)}
            oncomment={(body) => ws.addComment(body, { changeId: it.change.id })}
          />
        {:else if it.kind === 'comment'}
          <CommentCard
            item={it.thread}
            authors={ws.authors}
            me={ws.author.id}
            active={it.thread.threadId === ws.activeThreadId}
            onreply={(body) => ws.reply(it.thread.threadId, body)}
            onedit={(id, body) => ws.editComment(it.thread.threadId, id, body)}
            onresolve={(r) => ws.setResolved(it.thread.threadId, r)}
            onjump={() => ws.jumpToThread(it.thread.threadId)}
          />
        {:else}
          <DraftCard onsubmit={(body) => ws.addComment(body)} oncancel={() => ws.cancelComment()} />
        {/if}
      </div>
    {/each}
    {#if items.length === 0}
      <p class="empty">
        {#if ws.trackingOn}
          No changes or comments yet. Edits you make now will show up here; select text and press
          ⌘⌥C to comment.
        {:else}
          Track changes is off (⌘⌥T to turn it on). Select text and press ⌘⌥C to comment.
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
    min-width: 200px;
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
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font-weight: 400;
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
    padding: 6px 8px 0;
    transition: top 120ms ease-out;
  }
  .slot :global(.card) {
    position: relative;
    left: 0;
    right: 0;
    width: 100%;
    margin: 0;
  }
  .empty {
    color: var(--fg-muted);
    font-size: 12px;
    padding: 12px;
    margin: 0;
  }
</style>
