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

  async function update(
    id: string,
    patch: Partial<Pick<DocMeta, 'status' | 'tags' | 'libraryEligible'>>,
  ) {
    entries = entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
    await ws.setDocMeta(id, patch);
  }

  const ask = (message: string) => window.confirm(message);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  async function reload() {
    entries = await ws.libraryEntries();
  }

  async function chooseGenre(id: string, select: HTMLSelectElement) {
    const before = entries.find((e) => e.id === id)?.genre ?? '';
    if (await ws.setGenre(id, select.value || null, ask)) await reload();
    else select.value = before;
  }

  async function chooseClaude(id: string, select: HTMLSelectElement) {
    const e = entries.find((x) => x.id === id);
    const before = e?.claude === undefined ? 'follow' : e.claude ? 'on' : 'off';
    const v = select.value;
    if (await ws.setClaude(id, v === 'follow' ? null : v === 'on', ask)) await reload();
    else select.value = before;
  }

  async function togglePrivate(genreId: string, box: HTMLInputElement) {
    if (await ws.setGenrePrivate(genreId, box.checked, ask)) await reload();
    else box.checked = !box.checked;
  }

  let newGenre = $state('');
  let newGenrePrivate = $state(false);

  async function addGenre() {
    if (!newGenre.trim()) return;
    const id = await ws.createGenre(newGenre, newGenrePrivate);
    newGenre = '';
    newGenrePrivate = false;
    if (id) onclose();
  }

  let seedInput: HTMLInputElement | undefined = $state();
  let seedResult = $state('');

  /** Reads the Markdown files of a picked folder and hands them to the workspace. */
  async function importGuides(list: FileList | null) {
    const picked = [...(list ?? [])].filter((f) => /\.md$/i.test(f.name));
    const files = await Promise.all(
      picked.map(async (f) => ({ path: f.webkitRelativePath || f.name, text: await f.text() })),
    );
    seedResult = await ws.importSeed(files);
    await reload();
  }

  async function openBase() {
    await ws.openBaseGuide();
    onclose();
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

  <div class="panel guides" aria-label="Style guides">
    <div class="guides-head">
      <h2>Style guides</h2>
      <button onclick={openBase}
        >{ws.baseGuide
          ? `Open the base guide (${ws.baseGuide.guide?.principles.length ?? 0})`
          : 'Create the base guide'}</button
      >
      <button
        onclick={() => seedInput?.click()}
        title="Pick a folder holding base.md and one folder per genre with a guide.md. New guides are created; existing ones only gain principles they lack."
        >Import guides from a folder…</button
      >
      <input
        bind:this={seedInput}
        type="file"
        webkitdirectory
        multiple
        hidden
        onchange={(e) => {
          const input = e.currentTarget;
          void importGuides(input.files).then(() => (input.value = ''));
        }}
      />
    </div>
    {#if seedResult}<p class="result" role="status">{seedResult}</p>{/if}
    <p class="hint">
      The base guide holds principles for all your writing. A genre adds its own and can replace
      base ones. A private genre keeps Claude off its documents by default.
    </p>
    {#if ws.genres.length > 0}
      <ul class="genres">
        {#each ws.genres as g (g.id)}
          <li>
            <button class="open" onclick={() => onopen(g.id)}>{g.title}</button>
            <span class="muted"
              >{g.guide?.prefix} · {plural(g.guide?.principles.length ?? 0, 'principle')} · {plural(
                entries.filter((e) => e.genre === g.id).length,
                'document',
              )}</span
            >
            <label class="check"
              ><input
                type="checkbox"
                checked={!!g.guide?.private}
                onchange={(e) => void togglePrivate(g.id, e.currentTarget)}
              /> Private</label
            >
          </li>
        {/each}
      </ul>
    {/if}
    <form
      class="new-genre"
      onsubmit={(e) => {
        e.preventDefault();
        void addGenre();
      }}
    >
      <input type="text" placeholder="New genre, e.g. Papers" bind:value={newGenre} />
      <label class="check"><input type="checkbox" bind:checked={newGenrePrivate} /> Private</label>
      <button type="submit" disabled={!newGenre.trim()}>Create genre</button>
    </form>
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
          <th>Genre</th>
          <th title="Whether Claude Code may read the document">Claude</th>
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
            <td>
              {#if r.guide}
                <span class="muted">{r.guide.role === 'base' ? 'Base guide' : 'Genre guide'}</span>
              {:else}
                <select
                  value={r.genre ?? ''}
                  aria-label="Genre of {r.title}"
                  onchange={(e) => void chooseGenre(r.id, e.currentTarget)}
                >
                  <option value="">None</option>
                  {#each ws.genres as g (g.id)}
                    <option value={g.id}>{g.title}</option>
                  {/each}
                  {#if r.genre && !ws.genres.some((g) => g.id === r.genre)}
                    <option value={r.genre}>Deleted genre</option>
                  {/if}
                </select>
              {/if}
            </td>
            <td>
              <select
                class="claude"
                class:off={!ws.claudeAllowed(r)}
                value={r.claude === undefined ? 'follow' : r.claude ? 'on' : 'off'}
                aria-label="Claude access for {r.title}"
                onchange={(e) => void chooseClaude(r.id, e.currentTarget)}
              >
                <option value="follow"
                  >Default ({ws.claudeAllowed({ genre: r.genre, guide: r.guide })
                    ? 'on'
                    : 'off'})</option
                >
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
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
  .guides-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 15px;
  }
  .guides-head button,
  .new-genre button {
    border: 1px solid var(--border);
    padding: 4px 10px;
  }
  .hint {
    margin: 0;
    color: var(--fg-muted);
    font-size: 12px;
  }
  .genres {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .genres li {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .muted {
    color: var(--fg-muted);
    font-size: 12px;
  }
  .new-genre {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .new-genre input[type='text'] {
    flex: 1;
    max-width: 280px;
  }
  .claude.off {
    color: var(--fg-muted);
  }
</style>
