<script lang="ts">
  import { onMount } from 'svelte';
  import { createSettingsStore, type Layout } from '../settings/settings.svelte';
  import { createWorkspace } from '../docs/workspace.svelte';
  import { loadAuthor, saveAuthor } from '../docs/identity';
  import { attachFlushTriggers } from '../persist/autosave';
  import { requestPersistence } from '../persist/idb';
  import type { Author } from '../model/types';
  import Toolbar from './Toolbar.svelte';
  import Editor from './Editor.svelte';
  import Preview from './Preview.svelte';
  import SettingsPanel from './SettingsPanel.svelte';
  import DocumentList from './DocumentList.svelte';
  import Margin from './Margin.svelte';
  import StatusBar from './StatusBar.svelte';

  const settings = createSettingsStore();
  const ws = createWorkspace(loadAuthor());

  let docsOpen = $state(false);
  let settingsOpen = $state(false);
  let marginOpen = $state(true);
  let editor: Editor | undefined = $state();
  let tick = $state(0);

  const layout = $derived(settings.value.layout);
  const showMargin = $derived(marginOpen && layout !== 'preview' && ws.view === 'revision');

  function setLayout(l: Layout) {
    settings.set('layout', l);
    if (l !== 'preview') queueMicrotask(() => editor?.focus());
  }

  function setAuthor(a: Author) {
    ws.setAuthor(a);
    saveAuthor(a);
  }

  // Re-measure margin cards whenever the text, the pending set, or the layout changes.
  $effect(() => {
    void ws.text;
    void ws.pending;
    void ws.threads;
    void ws.draft;
    void layout;
    void showMargin;
    requestAnimationFrame(() => tick++);
  });

  function onKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    const code = e.code; // Alt can change e.key on some layouts; use physical keys for ⌘⌥ chords.
    if (e.altKey) {
      const act: Record<string, () => void> = {
        KeyT: () => ws.toggleTracking(),
        KeyA: () => void ws.acceptActive(),
        KeyR: () => void ws.rejectActive(),
        KeyN: () => ws.nextChange(),
        KeyP: () => ws.prevChange(),
        KeyM: () => (marginOpen = !marginOpen),
        KeyE: () => focusReason(),
        KeyC: () => {
          marginOpen = true;
          ws.startComment();
        },
      };
      const f = act[code];
      if (f) {
        e.preventDefault();
        f();
      }
      return;
    }
    if (key === 'e' && e.shiftKey) {
      e.preventDefault();
      setLayout(layout === 'split' ? 'editor' : 'split');
    } else if (key === 'e') {
      e.preventDefault();
      setLayout(layout === 'preview' ? 'editor' : 'preview');
    } else if (key === ',') {
      e.preventDefault();
      settingsOpen = !settingsOpen;
    } else if (key === 'd' && e.shiftKey) {
      e.preventDefault();
      docsOpen = !docsOpen;
    } else if (key === 'n' && !e.shiftKey) {
      e.preventDefault();
      void ws.create();
    } else if (key === 's') {
      // Saving is automatic; honour the habit anyway.
      e.preventDefault();
      void ws.flush();
    }
  }

  function focusReason() {
    const id = ws.activeChangeId;
    if (!id) return;
    marginOpen = true;
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(
        `.card[data-change="${id}"] .reason-text`,
      );
      input?.focus();
    });
  }

  onMount(() => {
    void ws.init();
    void requestPersistence();
    const detach = attachFlushTriggers(() => ws.flush());
    const onResize = () => tick++;
    window.addEventListener('resize', onResize);
    return () => {
      detach();
      window.removeEventListener('resize', onResize);
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  <Toolbar
    title={ws.title}
    {layout}
    view={ws.view}
    trackingOn={ws.trackingOn}
    pendingCount={ws.pending.length}
    {docsOpen}
    marginOpen={showMargin}
    {settingsOpen}
    canUndo={ws.canUndo}
    canRedo={ws.canRedo}
    onrename={(t) => ws.rename(t)}
    onlayout={setLayout}
    onview={(v) => ws.setView(v)}
    ontoggletracking={() => ws.toggleTracking()}
    oncomment={() => {
      marginOpen = true;
      ws.startComment();
    }}
    ontoggledocs={() => (docsOpen = !docsOpen)}
    ontogglemargin={() => (marginOpen = !marginOpen)}
    ontogglesettings={() => (settingsOpen = !settingsOpen)}
    onundo={() => {
      ws.undo();
      editor?.focus();
    }}
    onredo={() => {
      ws.redo();
      editor?.focus();
    }}
    onexport={(kind) => void ws.exportAs(kind)}
  />

  <div class="body">
    {#if docsOpen}
      <DocumentList
        docs={ws.docs}
        currentId={ws.current?.id}
        onopen={(id) => void ws.open(id)}
        oncreate={() => void ws.create()}
        ondelete={(id) => void ws.remove(id)}
        onimport={(f) => void ws.importFile(f)}
      />
    {/if}

    <main class="panes layout-{layout}">
      {#if ws.ready}
        {#if layout !== 'preview'}
          <div class="pane">
            <Editor bind:this={editor} {ws} onscroll={() => tick++} />
          </div>
        {/if}
        {#if layout !== 'editor'}
          <div class="pane preview-pane">
            <Preview text={ws.current ? ws.displayText : ''} />
          </div>
        {/if}
      {:else}
        <div class="loading">Opening…</div>
      {/if}
    </main>

    {#if showMargin && ws.ready}
      <Margin {ws} measure={(pos) => editor?.measureTop(pos)} {tick} />
    {/if}

    {#if settingsOpen}
      <SettingsPanel
        store={settings}
        author={ws.author}
        onauthor={setAuthor}
        onclose={() => (settingsOpen = false)}
      />
    {/if}
  </div>

  {#if ws.importNotice}
    <div class="notice" role="status">
      <span>{ws.importNotice}</span>
      <button onclick={() => ws.clearImportNotice()} aria-label="Dismiss">×</button>
    </div>
  {/if}

  <StatusBar
    text={ws.text}
    saveStatus={ws.saveStatus}
    lastSavedAt={ws.lastSavedAt}
    saveError={ws.saveError}
  />
</div>

<style>
  .app {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .panes {
    flex: 1;
    display: flex;
    min-width: 0;
    min-height: 0;
  }
  .pane {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .layout-split .pane + .pane {
    border-left: 1px solid var(--border);
  }
  .loading {
    margin: auto;
    color: var(--fg-muted);
  }
  .notice {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 12px;
    font-size: 12px;
    background: color-mix(in srgb, #eab308 20%, var(--bg-elev));
    border-top: 1px solid var(--border);
  }
</style>
