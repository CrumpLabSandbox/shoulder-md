<script lang="ts">
  import type { Workspace } from '../docs/workspace.svelte';
  import { CLAUDE_MODELS, type ClaudeModel } from '../app/bridge';

  /** Asks the user's own Claude Code to suggest edits to the open document (Mac app only). */
  let {
    ws,
    model,
    onmodel,
    onclose,
  }: {
    ws: Workspace;
    /** The model to request, remembered between runs. */
    model: ClaudeModel;
    onmodel: (m: ClaudeModel) => void;
    onclose: () => void;
  } = $props();

  let note = $state('');
  let blocked = $state<string | undefined>(undefined);
  let checked = $state(false);
  const run = $derived(ws.claudeRun);
  const guides = $derived(
    ws.currentGenre ? `the base guide and “${ws.currentGenre.title}”` : 'the base guide',
  );

  // Find out whether asking is possible before offering the form.
  $effect(() => {
    if (run) return;
    void ws.claudeBlocked().then((why) => {
      blocked = why;
      checked = true;
    });
  });

  function close() {
    ws.dismissClaude();
    onclose();
  }
</script>

<aside class="claude no-print" aria-label="Ask Claude">
  <header>
    <b>Ask Claude</b>
    <button onclick={close} aria-label="Close" disabled={run?.status === 'running'}>×</button>
  </header>

  {#if run}
    <p class="doc">“{run.title}”</p>
    {#if run.steps.length > 0}
      <ol class="steps">
        {#each run.steps.slice(-6) as step, i (i)}
          <li>{step}</li>
        {/each}
      </ol>
    {/if}
    {#if run.status === 'running'}
      <p class="state">Working… you can keep writing.</p>
      <div class="buttons">
        <button onclick={() => void ws.cancelClaude()}>Stop</button>
      </div>
    {:else if run.status === 'done'}
      <p class="summary">{run.summary || 'Finished.'}</p>
      <p class="state">Any proposed edits appear in a banner above; review them there.</p>
      <div class="buttons"><button class="primary" onclick={close}>Close</button></div>
    {:else}
      <p class="summary warn">{run.summary}</p>
      <div class="buttons"><button onclick={close}>Close</button></div>
    {/if}
  {:else if !checked}
    <p class="state">Checking…</p>
  {:else if blocked}
    <p class="summary">{blocked}</p>
    <div class="buttons"><button onclick={close}>Close</button></div>
  {:else}
    <p class="state">
      Claude Code will read this document and {guides}, then suggest edits. They arrive as tracked
      changes for you to accept or reject. It runs under your own Claude Code sign-in.
    </p>
    <textarea
      rows="3"
      placeholder="Anything to focus on? (optional)"
      bind:value={note}
      aria-label="Instructions for Claude"></textarea>
    <label class="model">
      Model
      <select
        value={model}
        onchange={(e) => onmodel(e.currentTarget.value as ClaudeModel)}
        aria-label="Claude model"
      >
        {#each CLAUDE_MODELS as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
    </label>
    <div class="buttons">
      <button class="primary" onclick={() => void ws.askClaude(note, model)}>Suggest edits</button>
      <button onclick={close}>Cancel</button>
    </div>
  {/if}
</aside>

<style>
  .claude {
    position: fixed;
    right: 16px;
    bottom: 44px;
    z-index: 20;
    width: 340px;
    max-height: 60vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-elev);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
    font-size: 13px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  p {
    margin: 0;
    line-height: 1.45;
  }
  .doc {
    font-weight: 600;
  }
  .state {
    color: var(--fg-muted);
    font-size: 12px;
  }
  .summary {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .summary.warn {
    color: #b45309;
  }
  .steps {
    margin: 0;
    padding-left: 18px;
    color: var(--fg-muted);
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  textarea {
    width: 100%;
    resize: vertical;
    font: inherit;
    font-size: 12px;
  }
  .model {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .buttons {
    display: flex;
    gap: 6px;
  }
  .buttons button {
    border: 1px solid var(--border);
    padding: 4px 10px;
  }
</style>
