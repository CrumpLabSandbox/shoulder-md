<script lang="ts">
  import type { PendingChange } from '../model/changes';
  import { formatTime } from '../util/time';

  let {
    change,
    color,
    name,
    active,
    onaccept,
    onreject,
    onreason,
    onjump,
  }: {
    change: PendingChange;
    color: string;
    name: string;
    active: boolean;
    onaccept: () => void;
    onreject: () => void;
    onreason: (reason: string | undefined, tags: string[]) => void;
    onjump: () => void;
  } = $props();

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
  const hasReason = $derived(!!change.record.reason || (change.record.reasonTags?.length ?? 0) > 0);
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

  <div class="reason" class:open={active || hasReason || editing}>
    <div class="tags">
      {#each TAGS as t (t)}
        <button class="tag" class:on={tags.includes(t)} onclick={() => toggleTag(t)}>{t}</button>
      {/each}
    </div>
    <input
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

  <footer>
    <button class="accept" onclick={onaccept} title="Accept (⌘⌥A)">Accept</button>
    <button class="reject" onclick={onreject} title="Reject (⌘⌥R)">Reject</button>
  </footer>
</article>

<style>
  .card {
    position: absolute;
    left: 8px;
    right: 8px;
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
    display: none;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 6px;
  }
  .reason.open,
  .card:hover .reason {
    display: flex;
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
  .reason-text {
    width: 100%;
    font-size: 12px;
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
