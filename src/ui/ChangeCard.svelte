<script lang="ts">
  import { tick } from 'svelte';
  import type { PendingChange } from '../model/changes';
  import { formatTime } from '../util/time';
  import type { ResolvedPrinciple } from '../guides/principles';

  let {
    change,
    color,
    name,
    active,
    onaccept,
    onreject,
    onreason,
    onjump,
    oncomment,
    showTags,
    reasonRequested,
    onreasonhandled,
    principles = [],
    onlink,
  }: {
    change: PendingChange;
    color: string;
    name: string;
    active: boolean;
    onaccept: () => void;
    onreject: () => void;
    onreason: (reason: string | undefined, tags: string[]) => void;
    onjump: () => void;
    oncomment: (body: string) => void;
    /** Show the reason tag chips. When on, the reason row is always shown so nothing shifts. */
    showTags: boolean;
    /** Open the reason field and focus it (⌘⌥E). */
    reasonRequested: boolean;
    onreasonhandled: () => void;
    /** The style guide principles that apply to this document. */
    principles?: ResolvedPrinciple[];
    /** Replaces the principles this change is linked to. */
    onlink?: (ids: string[]) => void;
  } = $props();

  let reasonInput: HTMLInputElement | undefined = $state();
  /** The free-text reason row, when tags are hidden, opens on demand and stays open. */
  let reasonOpen = $state(false);

  $effect(() => {
    if (!reasonRequested) return;
    reasonOpen = true;
    onreasonhandled();
    void tick().then(() => reasonInput?.focus());
  });

  let linking = $state(false);
  let filter = $state('');
  let filterInput: HTMLInputElement | undefined = $state();
  const linked = $derived(change.record.principles ?? []);
  const textOf = (id: string) => principles.find((p) => p.id === id)?.text;
  const matches = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? principles.filter(
          (p) => p.id.toLowerCase().startsWith(q) || p.text.toLowerCase().includes(q),
        )
      : principles;
    return list.slice(0, 8);
  });

  function toggleLink(id: string) {
    onlink?.(linked.includes(id) ? linked.filter((x) => x !== id) : [...linked, id]);
  }

  function openLinking() {
    linking = !linking;
    filter = '';
    if (linking) void tick().then(() => filterInput?.focus());
  }

  let commenting = $state(false);
  let commentText = $state('');

  function submitComment() {
    if (commentText.trim()) oncomment(commentText);
    commentText = '';
    commenting = false;
  }

  const TAGS = [
    'clarity',
    'concision',
    'grammar',
    'tone',
    'accuracy',
    'structure',
    'style',
    'other',
  ];

  let draft = $state('');
  let tags = $state<string[]>([]);
  let editing = $state(false);

  // Fill from the record, and keep in step when it changes underneath (e.g. after undo).
  $effect(() => {
    if (!editing) {
      draft = change.record.reason ?? '';
      tags = change.record.reasonTags ?? [];
    }
  });

  function toggleTag(t: string) {
    tags = tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t];
    onreason(draft || undefined, tags);
  }

  function commitText() {
    editing = false;
    if ((draft.trim() || undefined) !== change.record.reason)
      onreason(draft.trim() || undefined, tags);
  }

  function clip(s: string, n = 140) {
    const t = s.replace(/\n/g, '⏎');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  const when = $derived(change.record.ts ? formatTime(Date.parse(change.record.ts)) : '');
  const hasReason = $derived(!!change.record.reason);
  const savedTags = $derived(change.record.reasonTags ?? []);
  // Layout never depends on hover or on the cursor position: the reason row is shown when tags
  // are on, when a reason exists, or after the user asked for it.
  const showReasonRow = $derived(showTags || hasReason || reasonOpen || editing);
</script>

<article class="card" class:active style:--author-color={color} data-change={change.id}>
  <header>
    <button class="who" onclick={onjump} title="Jump to this change">
      <span class="dot"></span>{name}
    </button>
    <span class="when">{when}</span>
  </header>

  <p class="diff">
    {#if change.before}<del>{clip(change.before)}</del>{/if}
    {#if change.before && change.after}<span class="arrow"> → </span>{/if}
    {#if change.after}<ins>{clip(change.after)}</ins>{/if}
    {#if !change.before && !change.after}<em class="muted">(empty)</em>{/if}
  </p>

  <!-- Actions come before anything that can grow, so they never move under the pointer. -->
  <footer>
    <button class="accept" onclick={onaccept} title="Accept (⌘⌥A)">Accept</button>
    <button class="reject" onclick={onreject} title="Reject (⌘⌥R)">Reject</button>
    {#if !showReasonRow}
      <button
        class="why"
        onclick={() => {
          reasonOpen = true;
          void tick().then(() => reasonInput?.focus());
        }}
        title="Add a reason (⌘⌥E)">Why?</button
      >
    {/if}
    {#if principles.length > 0 && onlink}
      <button
        class="link"
        class:active={linking}
        onclick={openLinking}
        title="Link this change to style guide principles">§</button
      >
    {/if}
    <button class="comment" onclick={() => (commenting = !commenting)} title="Discuss this change"
      >💬</button
    >
  </footer>

  {#if showReasonRow}
    <div class="reason">
      {#if showTags}
        <div class="tags">
          {#each TAGS as t (t)}
            <button class="tag" class:on={tags.includes(t)} onclick={() => toggleTag(t)}>{t}</button
            >
          {/each}
        </div>
      {:else if savedTags.length > 0}
        <p class="saved-tags">{savedTags.join(' · ')}</p>
      {/if}
      <input
        bind:this={reasonInput}
        class="reason-text"
        type="text"
        placeholder="Why? (optional)"
        bind:value={draft}
        onfocus={() => (editing = true)}
        onblur={commitText}
        onkeydown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            draft = change.record.reason ?? '';
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  {/if}

  {#if linked.length > 0}
    <ul class="linked">
      {#each linked as id (id)}
        <li title={textOf(id) ?? 'Not in this document’s guides'}>
          <b>{id}</b>
          <span class="ptext">{textOf(id) ?? '(not found)'}</span>
          {#if onlink}
            <button
              class="unlink"
              onclick={() => toggleLink(id)}
              aria-label="Unlink {id}"
              title="Unlink">×</button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if linking}
    <div class="picker">
      <input
        bind:this={filterInput}
        type="text"
        placeholder="Find a principle by id or words…"
        bind:value={filter}
        onkeydown={(e) => {
          if (e.key === 'Escape') linking = false;
          if (e.key === 'Enter' && matches[0]) toggleLink(matches[0].id);
        }}
      />
      {#each matches as p (p.id)}
        <button class="choice" class:on={linked.includes(p.id)} onclick={() => toggleLink(p.id)}>
          <b>{p.id}</b>
          <span class="ptext">{p.text}</span>
        </button>
      {:else}
        <p class="muted">No principle matches.</p>
      {/each}
    </div>
  {/if}

  {#if commenting}
    <input
      class="comment-text"
      type="text"
      placeholder="Comment on this change… (Enter to post)"
      bind:value={commentText}
      onkeydown={(e) => {
        if (e.key === 'Enter') submitComment();
        if (e.key === 'Escape') commenting = false;
      }}
    />
  {/if}
</article>

<style>
  .card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-left: 3px solid var(--author-color);
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 12px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    transition: top 120ms ease-out;
  }
  .card.active {
    border-color: var(--author-color);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--author-color) 25%, transparent);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }
  .who {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    padding: 0 2px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--author-color);
  }
  .when {
    color: var(--fg-faint);
    font-size: 11px;
  }
  .diff {
    margin: 0 0 6px;
    font-family: var(--editor-font);
    font-size: 12px;
    line-height: 1.4;
    word-break: break-word;
  }
  del {
    color: var(--author-color);
    opacity: 0.75;
  }
  ins {
    color: var(--author-color);
    text-decoration-thickness: 1.5px;
  }
  .arrow {
    color: var(--fg-faint);
  }
  .muted {
    color: var(--fg-faint);
  }
  .reason {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }
  .saved-tags {
    margin: 0;
    font-size: 11px;
    color: var(--fg-muted);
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }
  .tag {
    font-size: 11px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--fg-muted);
  }
  .tag.on {
    background: var(--author-color);
    border-color: var(--author-color);
    color: #fff;
  }
  .reason-text,
  .comment-text {
    width: 100%;
    font-size: 12px;
  }
  .comment-text {
    margin-top: 6px;
  }
  .why {
    color: var(--fg-muted);
  }
  .linked {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .linked li,
  .choice {
    display: flex;
    gap: 6px;
    align-items: baseline;
    font-size: 11px;
    min-width: 0;
  }
  .ptext {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-muted);
    flex: 1;
    min-width: 0;
  }
  .unlink {
    padding: 0 4px;
    color: var(--fg-faint);
  }
  .picker {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .picker input {
    font-size: 12px;
    margin-bottom: 2px;
  }
  .choice {
    text-align: left;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .choice.on {
    background: color-mix(in srgb, var(--author-color) 18%, transparent);
  }
  .link {
    margin-left: auto;
    padding: 2px 6px;
  }
  .link + .comment {
    margin-left: 0;
  }
  .comment {
    margin-left: auto;
    padding: 2px 6px;
  }
  footer {
    display: flex;
    gap: 6px;
  }
  footer button {
    font-size: 12px;
    padding: 2px 8px;
    border: 1px solid var(--border);
  }
  .accept:hover {
    background: color-mix(in srgb, #16a34a 15%, transparent);
    border-color: #16a34a;
  }
  .reject:hover {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border-color: var(--danger);
  }
</style>
