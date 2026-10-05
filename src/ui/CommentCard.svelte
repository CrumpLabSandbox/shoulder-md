<script lang="ts">
  import type { Thread } from '../docs/workspace.svelte';
  import type { Author } from '../model/types';
  import { authorColor, authorName } from '../docs/identity';
  import { formatTime } from '../util/time';

  let {
    item,
    authors,
    me,
    active,
    onreply,
    onedit,
    onresolve,
    onjump,
  }: {
    item: Thread;
    authors: Author[];
    me: string;
    active: boolean;
    onreply: (body: string) => void;
    onedit: (commentId: string, body: string) => void;
    onresolve: (resolved: boolean) => void;
    onjump: () => void;
  } = $props();

  let replyText = $state('');
  let editingId = $state<string | undefined>(undefined);
  let editText = $state('');

  const first = $derived(item.thread.comments[0]);

  function submitReply() {
    if (!replyText.trim()) return;
    onreply(replyText);
    replyText = '';
  }

  function startEdit(id: string, body: string) {
    editingId = id;
    editText = body;
  }

  function commitEdit() {
    if (editingId && editText.trim()) onedit(editingId, editText);
    editingId = undefined;
  }
</script>

<article
  class="card comment"
  class:active
  class:resolved={item.resolved}
  class:orphaned={item.orphaned}
  data-thread={item.threadId}
  style:--author-color={first ? authorColor(first.author, authors) : 'var(--accent)'}
>
  <header>
    <button class="who" onclick={onjump} title="Jump to the commented text">
      <span class="dot"></span>{first ? authorName(first.author, authors) : ''}
    </button>
    <span class="when">
      {#if item.changeId}<span class="link" title="Discussion of a change">↳ change</span>{/if}
      {first ? formatTime(Date.parse(first.ts)) : ''}
    </span>
  </header>

  {#if item.orphaned}
    <p class="notice">The commented text was removed.</p>
  {/if}

  <ol class="thread">
    {#each item.thread.comments as c, i (c.id)}
      <li>
        {#if i > 0}
          <span class="reply-who" style:--author-color={authorColor(c.author, authors)}>
            <span class="dot"></span>{authorName(c.author, authors)}
          </span>
        {/if}
        {#if editingId === c.id}
          <textarea
            class="edit"
            bind:value={editText}
            rows="2"
            onkeydown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitEdit();
              }
              if (e.key === 'Escape') editingId = undefined;
            }}
            onblur={commitEdit}></textarea>
        {:else}
          <p class="body">{c.body}</p>
          {#if c.author === me && !item.resolved}
            <button class="tiny" onclick={() => startEdit(c.id, c.body)}>edit</button>
          {/if}
        {/if}
      </li>
    {/each}
  </ol>

  {#if !item.resolved}
    <div class="replybox">
      <input
        type="text"
        class="reply-text"
        placeholder="Reply…"
        bind:value={replyText}
        onkeydown={(e) => {
          if (e.key === 'Enter') submitReply();
        }}
      />
    </div>
  {/if}

  <footer>
    {#if item.resolved}
      <button onclick={() => onresolve(false)}>Reopen</button>
    {:else}
      <button class="resolve" onclick={() => onresolve(true)}>Resolve</button>
    {/if}
  </footer>
</article>

<style>
  .card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-left: 3px solid #eab308;
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 12px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  }
  .card.active {
    box-shadow: 0 0 0 2px color-mix(in srgb, #eab308 40%, transparent);
  }
  .card.resolved {
    opacity: 0.65;
    border-left-color: var(--fg-faint);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }
  .who,
  .reply-who {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    padding: 0 2px;
  }
  .reply-who {
    font-size: 11px;
    color: var(--fg-muted);
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
    display: inline-flex;
    gap: 6px;
  }
  .link {
    color: var(--fg-muted);
  }
  .notice {
    margin: 0 0 4px;
    color: var(--fg-muted);
    font-style: italic;
  }
  .thread {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .thread li + li {
    border-top: 1px solid var(--border);
    padding-top: 4px;
  }
  .body {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tiny {
    font-size: 10px;
    color: var(--fg-faint);
    padding: 0 4px;
  }
  .edit,
  .reply-text {
    width: 100%;
    font-size: 12px;
    font-family: inherit;
  }
  .replybox {
    margin-top: 6px;
  }
  footer {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  footer button {
    font-size: 12px;
    padding: 2px 8px;
    border: 1px solid var(--border);
  }
  .resolve:hover {
    background: color-mix(in srgb, #16a34a 15%, transparent);
    border-color: #16a34a;
  }
</style>
