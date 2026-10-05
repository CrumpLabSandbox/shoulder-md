<script lang="ts">
  import { onMount } from 'svelte';

  let { onsubmit, oncancel }: { onsubmit: (body: string) => void; oncancel: () => void } = $props();
  let body = $state('');
  let box: HTMLTextAreaElement;

  onMount(() => box.focus());
</script>

<article class="card draft">
  <textarea
    bind:this={box}
    bind:value={body}
    rows="3"
    placeholder="Comment… (Enter to post, Shift+Enter for a new line, Esc to cancel)"
    onkeydown={(e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (body.trim()) onsubmit(body);
      }
      if (e.key === 'Escape') oncancel();
    }}></textarea>
  <footer>
    <button class="primary" onclick={() => body.trim() && onsubmit(body)}>Comment</button>
    <button onclick={oncancel}>Cancel</button>
  </footer>
</article>

<style>
  .card {
    background: var(--bg-elev);
    border: 1px solid #eab308;
    border-left: 3px solid #eab308;
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 12px;
  }
  textarea {
    width: 100%;
    font: inherit;
    font-size: 12px;
    resize: vertical;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 6px;
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
</style>
