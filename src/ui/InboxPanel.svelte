<script lang="ts">
  import { onMount } from 'svelte';
  import type { Workspace } from '../docs/workspace.svelte';
  import { appBridge, CLAUDE_MODELS, type ClaudeModel } from '../app/bridge';
  import type { InboxEdit, InboxSuggestion } from '../guides/inbox';

  /**
   * The principle inbox: principles Claude Code suggests from the author's own reasoned edits,
   * reviewed one at a time. Adding one puts it in a guide as a tracked change.
   */
  let {
    ws,
    model,
    onmodel,
    onopen,
  }: {
    ws: Workspace;
    model: ClaudeModel;
    onmodel: (m: ClaudeModel) => void;
    /** Opens a document (a guide, after adding to it). */
    onopen: (id: string) => void;
  } = $props();

  const inApp = !!appBridge();
  let all = $state(false);
  let blocked = $state<string | undefined>(undefined);
  /** Edits the author made to a suggestion before deciding, by position. */
  let wording = $state<Record<number, string>>({});
  let target = $state<Record<number, string>>({});

  const running = $derived(ws.claudeRun?.kind === 'inbox' && ws.claudeRun.status === 'running');
  const guides = $derived(['base', ...ws.genres.map((g) => g.title)]);
  const connected = $derived(ws.folder.status === 'connected');

  onMount(() => void ws.refreshInbox());

  // A suggestion list that changes (one settled, a new run) makes edits by position stale.
  $effect(() => {
    void ws.inbox;
    wording = {};
    target = {};
  });

  async function run() {
    blocked = await ws.claudeBlocked('inbox');
    if (!blocked) await ws.suggestFromEdits(all, model);
  }

  const editsOf = (s: InboxSuggestion): InboxEdit[] =>
    s.edits.map((id) => ws.inboxEdits.find((e) => e.id === id)).filter((e): e is InboxEdit => !!e);
  const guideLabel = (g: string) => (g.toLowerCase() === 'base' ? 'Base guide' : g);
  const guideId = (name: string) =>
    name.toLowerCase() === 'base'
      ? ws.baseGuide?.id
      : ws.genres.find((g) => g.title.toLowerCase() === name.toLowerCase())?.id;
  const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
</script>

{#snippet change(e: InboxEdit)}
  <li>
    <span class="diff">
      {#if e.before}<del>{clip(e.before)}</del>{/if}
      {#if e.before && e.after}<span class="arrow"> → </span>{/if}
      {#if e.after}<ins>{clip(e.after)}</ins>{/if}
    </span>
    <span class="why">{e.reason ?? e.setReason}</span>
    <span class="where">{e.document}{e.genre ? ` · ${e.genre}` : ''}</span>
  </li>
{/snippet}

<div class="panel inbox" aria-label="Principle inbox">
  <div class="head">
    <h2>Principle inbox</h2>
    {#if inApp}
      <label class="check"
        ><input type="checkbox" bind:checked={all} disabled={running} /> Look at every edit again</label
      >
      <select
        value={model}
        onchange={(e) => onmodel(e.currentTarget.value as ClaudeModel)}
        aria-label="Claude model"
        disabled={running}
      >
        {#each CLAUDE_MODELS as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
      <button onclick={() => void run()} disabled={running}
        >{running ? 'Working…' : 'Suggest principles from my edits'}</button
      >
    {/if}
  </div>
  <p class="hint">
    Claude reads the edits you gave a reason for, in documents it is allowed to see, and suggests
    principles they have in common. Nothing changes a guide until you add it here, and then it
    arrives as a tracked change.
    {#if !inApp}Running this needs the Mac app; suggestions already in the folder can be reviewed
      here.{/if}
  </p>
  {#if blocked}<p class="warn" role="status">{blocked}</p>{/if}
  {#if !connected}
    <p class="hint">Choose a shared folder (below) to use the inbox.</p>
  {:else if ws.inbox.suggestions.length + ws.inbox.links.length === 0}
    <p class="empty">Nothing waiting.</p>
  {/if}

  {#each ws.inbox.suggestions as s, i (i)}
    {@const guide = target[i] ?? s.guide}
    <article class="card">
      <header>
        <span class="kind">{s.kind === 'reword' ? `Reword ${s.id}` : 'New principle'}</span>
        {#if s.kind === 'reword'}
          <span class="muted">in {guideLabel(s.guide)}</span>
        {:else}
          <label class="muted"
            >for
            <select
              value={guide}
              onchange={(e) => (target = { ...target, [i]: e.currentTarget.value })}
              aria-label="Guide to add it to"
            >
              {#each guides.includes(s.guide) ? guides : [...guides, s.guide] as g (g)}
                <option value={g}>{guideLabel(g)}</option>
              {/each}
            </select></label
          >
          {#if s.section}<span class="muted">under “{s.section}”</span>{/if}
        {/if}
      </header>
      {#if s.kind === 'reword' && s.id && ws.principleText(s.id)}
        <p class="was">Now: {ws.principleText(s.id)}</p>
      {/if}
      <textarea
        rows="2"
        value={wording[i] ?? s.principle}
        oninput={(e) => (wording = { ...wording, [i]: e.currentTarget.value })}
        aria-label="Principle wording"></textarea>
      {#if s.reason}<p class="reason">{s.reason}</p>{/if}
      {#if editsOf(s).length > 0}
        <details>
          <summary
            >{editsOf(s).length} supporting {editsOf(s).length === 1 ? 'edit' : 'edits'}</summary
          >
          <ul class="edits">
            {#each editsOf(s) as e (e.id)}{@render change(e)}{/each}
          </ul>
        </details>
      {/if}
      <footer>
        <button
          class="primary"
          onclick={() => void ws.resolveSuggestion(i, 'add', { guide, principle: wording[i] })}
          >{s.kind === 'reword' ? 'Reword it' : `Add to ${guideLabel(guide)}`}</button
        >
        <button onclick={() => void ws.resolveSuggestion(i, 'dismiss')}>Dismiss</button>
        {#if guideId(guide)}
          <button class="link" onclick={() => onopen(guideId(guide)!)}>Open the guide</button>
        {/if}
      </footer>
    </article>
  {/each}

  {#if ws.inbox.links.length > 0}
    <h3>Edits that look like existing principles</h3>
    {#each ws.inbox.links as l, i (i)}
      {@const e = ws.inboxEdits.find((x) => x.id === l.edit)}
      <article class="card link-card">
        {#if e}
          <ul class="edits">{@render change(e)}</ul>
        {:else}
          <p class="muted">An edit that is no longer in the digest.</p>
        {/if}
        {#each l.principles as id (id)}
          <p class="was"><b>{id}</b> {ws.principleText(id) ?? '(not found)'}</p>
        {/each}
        {#if l.reason}<p class="reason">{l.reason}</p>{/if}
        <footer>
          <button class="primary" onclick={() => void ws.resolveLink(i, true)}>Link them</button>
          <button onclick={() => void ws.resolveLink(i, false)}>Skip</button>
        </footer>
      </article>
    {/each}
  {/if}
</div>

<style>
  .panel {
    max-width: 1100px;
    margin: 16px auto;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-elev);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    flex: 1;
  }
  h3 {
    margin: 6px 0 0;
    font-size: 13px;
  }
  .head button,
  footer button {
    border: 1px solid var(--border);
    padding: 4px 10px;
  }
  .head select,
  .card select {
    font-size: 12px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--fg-muted);
  }
  p {
    margin: 0;
    line-height: 1.45;
  }
  .hint,
  .empty,
  .muted,
  .where {
    color: var(--fg-muted);
    font-size: 12px;
  }
  .warn {
    color: #b45309;
    font-size: 12px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
  }
  .card header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .kind {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent);
  }
  textarea {
    width: 100%;
    resize: vertical;
    font: inherit;
    font-size: 13px;
  }
  .reason {
    font-size: 12px;
  }
  .was {
    font-size: 12px;
    color: var(--fg-muted);
  }
  details summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .edits {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .edits li {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 12px;
    padding-left: 8px;
    border-left: 2px solid var(--border);
  }
  .diff del {
    opacity: 0.7;
  }
  .diff ins {
    text-decoration-thickness: 1.5px;
  }
  .arrow {
    color: var(--fg-faint);
  }
  .why {
    font-style: italic;
  }
  footer {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .link {
    border: none !important;
    color: var(--fg-muted);
    text-decoration: underline;
  }
</style>
