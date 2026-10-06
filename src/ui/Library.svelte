<script lang="ts">
  import { onMount } from 'svelte';
  import type { Workspace } from '../docs/workspace.svelte';
  import type { LibraryEntry } from '../persist/idb';
  import type { DocMeta } from '../model/types';

  let {
    ws,
    libraryDefault,
    onlibrarydefault,
    onopen,
    onclose,
  }: {
    ws: Workspace;
    libraryDefault: boolean;
    onlibrarydefault: (v: boolean) => void;
    onopen: (id: string) => void;
    onclose: () => void;
  } = $props();

  let entries = $state.raw<LibraryEntry[]>([]);
  let loading = $state(true);
  let query = $state('');
  let statusFilter = $state<'all' | DocMeta['status']>('all');
  let onlyLibrary = $state(false);
  let includePending = $state(false);
  let includeUntracked = $state(false);
  let exportResult = $state<string | undefined>(undefined);
  let exporting = $state(false);
  let searchBox: HTMLInputElement;

  onMount(() => {
    void ws.libraryEntries().then((e) => {
      entries = e;
      loading = false;
    });
    searchBox.focus();
  });

  type Row = LibraryEntry & { snippet?: string };

  const rows = $derived.by<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Row[] = [];
    for (const e of entries) {
      if (onlyLibrary && !e.libraryEligible) continue;
      if (statusFilter !== 'all' && e.status !== statusFilter) continue;
      if (!q) {
        out.push(e);
        continue;
      }
      const inTitle = e.title.toLowerCase().includes(q);
      const inTags = e.tags.some((t) => t.toLowerCase().includes(q));
      const at = e.text.toLowerCase().indexOf(q);
      if (!inTitle && !inTags && at < 0) continue;
      out.push(at >= 0 && !inTitle ? { ...e, snippet: snippetAt(e.text, at, q.length) } : e);
    }
    return out;
  });

  const summary = $derived.by(() => {
    const lib = entries.filter((e) => e.libraryEligible);
    const accepted = lib.reduce((n, e) => n + e.acceptedChanges, 0);
    const rejected = lib.reduce((n, e) => n + e.rejectedChanges, 0);
    const reasoned = lib.reduce((n, e) => n + e.reasoned, 0);
    const decided = accepted + rejected;
    return {
      docs: lib.length,
      decided,
      reasoned,
      rate: decided ? Math.round((accepted / decided) * 100) : undefined,
    };
  });

  function snippetAt(text: string, at: number, len: number): string {
    const start = Math.max(0, at - 40);
    const end = Math.min(text.length, at + len + 60);
    return (
      (start > 0 ? '…' : '') +
      text.slice(start, end).replace(/\s+/g, ' ') +
      (end < text.length ? '…' : '')
    );
  }

  async function update(id: string, patch: Partial<Omit<DocMeta, 'title'>>) {
    entries = entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
    await ws.setDocMeta(id, patch);
  }

  function parseTags(s: string): string[] {
    return [
      ...new Set(
        s
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ];
  }

  async function doExport() {
    exporting = true;
    try {
      const r = await ws.exportLibrary({ includePending, includeUntracked });
      exportResult = `Exported ${r.rows} ${r.rows === 1 ? 'record' : 'records'} from ${r.docs} ${r.docs === 1 ? 'document' : 'documents'}.`;
    } finally {
      exporting = false;
    }
  }

  function when(iso: string) {
    return new Date(iso).toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) onclose();
  }}
/>

<section class="library" aria-label="Library">
  <header>
    <div class="title-row">
      <h1>Library</h1>
      <button class="close" onclick={onclose} aria-label="Close library" title="Close (Esc)"
        >×</button
      >
    </div>
    <p class="lede">
      Documents you include here, with every change, its reason, and whether it was kept, form the
      dataset for teaching Claude your editing. Nothing is included unless you tick it.
    </p>
    <div class="controls">
      <input
        bind:this={searchBox}
        class="search"
        type="search"
        placeholder="Search titles, tags, and text…"
        bind:value={query}
      />
      <select bind:value={statusFilter} aria-label="Status filter">
        <option value="all">All statuses</option>
        <option value="draft">Draft</option>
        <option value="in-review">In review</option>
        <option value="final">Final</option>
      </select>
      <label class="check"
        ><input type="checkbox" bind:checked={onlyLibrary} /> In library only</label
      >
    </div>
  </header>

  <div class="panel">
    <div class="stats">
      <span><b>{summary.docs}</b> in the library</span>
      <span><b>{summary.decided}</b> decided changes</span>
      <span><b>{summary.reasoned}</b> with reasons</span>
      {#if summary.rate !== undefined}<span><b>{summary.rate}%</b> accepted</span>{/if}
    </div>
    <div class="export">
      <label class="check"
        ><input type="checkbox" bind:checked={includePending} /> Include pending</label
      >
      <label class="check"
        ><input type="checkbox" bind:checked={includeUntracked} /> Include untracked edits</label
      >
      <button class="primary" disabled={summary.docs === 0 || exporting} onclick={doExport}>
        Export change records (.jsonl)
      </button>
    </div>
    {#if exportResult}<p class="result" role="status">{exportResult}</p>{/if}
    <label class="check default">
      <input
        type="checkbox"
        checked={libraryDefault}
        onchange={(e) => onlibrarydefault(e.currentTarget.checked)}
      />
      New documents join the library
    </label>
  </div>

  {#if loading}
    <p class="empty">Loading…</p>
  {:else if rows.length === 0}
    <p class="empty">{entries.length === 0 ? 'No documents yet.' : 'Nothing matches.'}</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th class="c-in" title="Include in the library">In</th>
          <th>Document</th>
          <th>Status</th>
          <th>Tags</th>
          <th class="num" title="Accepted / rejected / pending tracked changes">Changes</th>
          <th class="num" title="Tracked changes with a reason">Reasons</th>
          <th class="num">Words</th>
          <th class="num">Edited</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.id)}
          <tr class:current={r.id === ws.current?.id} data-doc={r.id}>
            <td class="c-in">
              <input
                type="checkbox"
                aria-label="Include {r.title} in the library"
                checked={r.libraryEligible}
                onchange={(e) => void update(r.id, { libraryEligible: e.currentTarget.checked })}
              />
            </td>
            <td class="doc">
              <button class="open" onclick={() => onopen(r.id)}>{r.title}</button>
              {#if r.snippet}<div class="snippet">{r.snippet}</div>{/if}
            </td>
            <td>
              <select
                value={r.status}
                aria-label="Status of {r.title}"
                onchange={(e) =>
                  void update(r.id, { status: e.currentTarget.value as DocMeta['status'] })}
              >
                <option value="draft">Draft</option>
                <option value="in-review">In review</option>
                <option value="final">Final</option>
              </select>
            </td>
            <td>
              <input
                class="tags"
                type="text"
                value={r.tags.join(', ')}
                placeholder="tags, comma separated"
                aria-label="Tags of {r.title}"
                onchange={(e) => void update(r.id, { tags: parseTags(e.currentTarget.value) })}
                onkeydown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            </td>
            <td class="num">
              <span class="acc" title="Accepted">{r.acceptedChanges}</span> /
              <span class="rej" title="Rejected">{r.rejectedChanges}</span> /
              <span title="Pending">{r.pendingChanges}</span>
            </td>
            <td class="num">{r.reasoned}</td>
            <td class="num">{r.words.toLocaleString()}</td>
            <td class="num">{when(r.updatedAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .library {
    flex: 1;
    overflow: auto;
    padding: 24px 32px 64px;
    min-width: 0;
  }
  header,
  .panel,
  table,
  .empty {
    max-width: 1100px;
    margin-left: auto;
    margin-right: auto;
  }
  .title-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h1 {
    margin: 0;
    font-size: 22px;
  }
  .close {
    font-size: 18px;
  }
  .lede {
    color: var(--fg-muted);
    margin: 6px 0 16px;
    max-width: 70ch;
    line-height: 1.5;
  }
  .controls {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .search {
    flex: 1;
    min-width: 240px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 8px;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .panel {
    margin-top: 16px;
    margin-bottom: 16px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-elev);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .stats {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
    color: var(--fg-muted);
  }
  .stats b {
    color: var(--fg);
  }
  .export {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  .export .primary {
    margin-left: auto;
    padding: 5px 12px;
  }
  .export .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .result {
    margin: 0;
    color: #15803d;
  }
  .default {
    color: var(--fg-muted);
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th {
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--fg-muted);
    font-weight: 600;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  tr.current td {
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }
  .num {
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .c-in {
    width: 32px;
    text-align: center;
  }
  .open {
    font-weight: 600;
    text-align: left;
    padding: 0;
  }
  .open:hover {
    background: none;
    text-decoration: underline;
  }
  .snippet {
    color: var(--fg-muted);
    font-size: 12px;
    margin-top: 2px;
  }
  .tags {
    width: 100%;
    min-width: 140px;
  }
  .acc {
    color: #15803d;
  }
  .rej {
    color: var(--danger);
  }
  .empty {
    color: var(--fg-muted);
  }
</style>
