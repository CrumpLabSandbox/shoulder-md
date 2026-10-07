<script lang="ts">
  import { tick } from 'svelte';
  import type { Workspace } from '../docs/workspace.svelte';
  import { CLAUDE_MODELS, type ClaudeModel } from '../app/bridge';
  import { renderMarkdown } from '../preview/render';

  /**
   * A conversation with the user's own Claude Code about the open document (Mac app only).
   * Claude can answer, suggest small tracked edits, or write a larger revision; edits always
   * come back as tracked changes through the banners above the status bar.
   */
  let {
    ws,
    model,
    onmodel,
    onclose,
  }: {
    ws: Workspace;
    model: ClaudeModel;
    onmodel: (m: ClaudeModel) => void;
    onclose: () => void;
  } = $props();

  const SUGGEST =
    'Suggest tracked-change edits for this document, following its style guides (the propose-edits skill).';

  let draft = $state('');
  let log: HTMLDivElement | undefined = $state();
  let input: HTMLTextAreaElement | undefined = $state();
  const chat = $derived(ws.chat);

  // Keep the newest message in view.
  $effect(() => {
    void chat.messages.length;
    void chat.steps.length;
    void tick().then(() => log?.scrollTo({ top: log.scrollHeight }));
  });

  $effect(() => {
    void tick().then(() => input?.focus());
  });

  function send(text = draft) {
    if (!text.trim() || chat.running) return;
    draft = '';
    void ws.sendChat(text, model);
  }
</script>

<aside class="chat no-print" aria-label="Chat with Claude">
  <header>
    <b>Claude</b>
    <select
      value={model}
      onchange={(e) => onmodel(e.currentTarget.value as ClaudeModel)}
      aria-label="Claude model"
      title="Which model Claude Code uses"
    >
      {#each CLAUDE_MODELS as m (m.id)}
        <option value={m.id}>{m.label}</option>
      {/each}
    </select>
    <span class="spacer"></span>
    <button
      onclick={() => ws.clearChat()}
      disabled={chat.running || chat.messages.length === 0}
      title="Start a new conversation">New</button
    >
    <button onclick={onclose} aria-label="Close chat">×</button>
  </header>

  <div class="log" bind:this={log}>
    {#if chat.messages.length === 0}
      <p class="hint">
        Ask about “{ws.title}”, or ask for changes. Small edits and larger rewrites both come back
        as tracked changes for you to accept or reject. This runs your own Claude Code, under its
        sign-in.
      </p>
    {/if}
    {#each chat.messages as m, i (i)}
      {#if m.role === 'you'}
        <p class="you">{m.text}</p>
      {:else if m.role === 'error'}
        <p class="error">{m.text}</p>
      {:else}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- output is sanitized by DOMPurify in renderMarkdown -->
        <div class="claude">{@html renderMarkdown(m.text)}</div>
      {/if}
    {/each}
    {#if chat.running}
      <div class="working">
        <p>Working…</p>
        {#if chat.steps.length > 0}
          <ol>
            {#each chat.steps.slice(-5) as step, i (i)}
              <li>{step}</li>
            {/each}
          </ol>
        {/if}
      </div>
    {/if}
  </div>

  <footer>
    <div class="quick">
      <button onclick={() => send(SUGGEST)} disabled={chat.running}>Suggest tracked edits</button>
      {#if chat.running}
        <button onclick={() => void ws.cancelClaude()}>Stop</button>
      {/if}
    </div>
    <textarea
      bind:this={input}
      bind:value={draft}
      rows="3"
      placeholder="Ask a question, or say what to change…"
      aria-label="Message to Claude"
      onkeydown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          send();
        }
      }}></textarea>
    <div class="quick">
      <span class="hint">Enter to send, Shift+Enter for a new line</span>
      <span class="spacer"></span>
      <button class="primary" onclick={() => send()} disabled={chat.running || !draft.trim()}
        >Send</button
      >
    </div>
  </footer>
</aside>

<style>
  .chat {
    width: 360px;
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--border);
    background: var(--bg-elev);
    font-size: 13px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  header select {
    font-size: 12px;
    max-width: 150px;
  }
  .spacer {
    flex: 1;
  }
  .log {
    flex: 1;
    overflow: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  p {
    margin: 0;
    line-height: 1.45;
  }
  .hint {
    color: var(--fg-muted);
    font-size: 12px;
  }
  .you {
    align-self: flex-end;
    max-width: 90%;
    padding: 6px 10px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .claude {
    font-size: 13px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .claude :global(p) {
    margin: 0 0 6px;
  }
  .claude :global(:last-child) {
    margin-bottom: 0;
  }
  .claude :global(code) {
    font-size: 12px;
  }
  .claude :global(ul),
  .claude :global(ol) {
    margin: 0 0 6px;
    padding-left: 20px;
  }
  .error {
    color: #b45309;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .working {
    color: var(--fg-muted);
    font-size: 12px;
  }
  .working ol {
    margin: 2px 0 0;
    padding-left: 18px;
  }
  footer {
    border-top: 1px solid var(--border);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  textarea {
    width: 100%;
    resize: vertical;
    font: inherit;
  }
  .quick {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .quick button,
  header button {
    border: 1px solid var(--border);
    padding: 3px 9px;
    font-size: 12px;
  }
</style>
