<script lang="ts">
  import type { DocSummary } from '../persist/idb';

  let {
    docs,
    currentId,
    onopen,
    oncreate,
    ondelete,
    onimport,
  }: {
    docs: DocSummary[];
    currentId: string | undefined;
    onopen: (id: string) => void;
    oncreate: () => void;
    ondelete: (id: string) => void;
    onimport: (file: File) => void;
  } = $props();

  let fileInput: HTMLInputElement;

  function when(iso: string) {
    const d = new Date(iso);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function confirmDelete(doc: DocSummary) {
    if (confirm(`Delete "${doc.title}"? This cannot be undone.`)) ondelete(doc.id);
  }
</script>

<aside class="docs no-print" aria-label="Documents">
  <div class="head">
    <span>Documents</span>
    <span class="actions">
      <button
        onclick={() => fileInput.click()}
        title="Import a Markdown, CriticMarkup, or .shoulder.json file">Import…</button
      >
      <button class="primary" onclick={oncreate} title="New document (⌘N)">+ New</button>
    </span>
    <input
      bind:this={fileInput}
      type="file"
      accept=".md,.markdown,.txt,.json"
      hidden
      onchange={(e) => {
        const f = e.currentTarget.files?.[0];
        if (f) onimport(f);
        e.currentTarget.value = '';
      }}
    />
  </div>
  <ul>
    {#each docs as doc (doc.id)}
      <li class:current={doc.id === currentId}>
        <button class="open" onclick={() => onopen(doc.id)}>
          <span class="title">{doc.title}</span>
          <span class="meta">{when(doc.updatedAt)} · {doc.words} words</span>
        </button>
        <button
          class="delete danger"
          onclick={() => confirmDelete(doc)}
          title="Delete"
          aria-label="Delete {doc.title}"
        >
          ×
        </button>
      </li>
    {/each}
  </ul>
</aside>

<style>
  .docs {
    width: 260px;
    flex: none;
    border-right: 1px solid var(--border);
    background: var(--bg-elev);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .actions {
    display: flex;
    gap: 4px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 10px;
    font-weight: 600;
    border-bottom: 1px solid var(--border);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow: auto;
  }
  li {
    display: flex;
    align-items: stretch;
    border-radius: 6px;
  }
  li:hover {
    background: var(--bg-sunk);
  }
  li.current {
    background: var(--bg-sunk);
    outline: 1px solid var(--border);
  }
  .open {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    text-align: left;
    gap: 2px;
    padding: 6px 8px;
    min-width: 0;
  }
  .open:hover {
    background: transparent;
  }
  .title {
    font-weight: 500;
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    font-size: 11px;
    color: var(--fg-muted);
  }
  .delete {
    opacity: 0;
    padding: 0 8px;
  }
  li:hover .delete,
  .delete:focus-visible {
    opacity: 1;
  }
</style>
