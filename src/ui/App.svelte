<script lang="ts">
  import { onMount } from 'svelte';
  import { createSettingsStore, type Layout } from '../settings/settings.svelte';
  import { createWorkspace } from '../docs/workspace.svelte';
  import { attachFlushTriggers } from '../persist/autosave';
  import { requestPersistence } from '../persist/idb';
  import Toolbar from './Toolbar.svelte';
  import Editor from './Editor.svelte';
  import Preview from './Preview.svelte';
  import SettingsPanel from './SettingsPanel.svelte';
  import DocumentList from './DocumentList.svelte';
  import StatusBar from './StatusBar.svelte';

  const settings = createSettingsStore();
  const ws = createWorkspace();

  let docsOpen = $state(false);
  let settingsOpen = $state(false);
  let editor: Editor | undefined = $state();

  const layout = $derived(settings.value.layout);

  function setLayout(l: Layout) {
    settings.set('layout', l);
    if (l !== 'preview') queueMicrotask(() => editor?.focus());
  }

  function onKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
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

  onMount(() => {
    void ws.init();
    void requestPersistence();
    const detach = attachFlushTriggers(() => ws.flush());
    return detach;
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="app">
  <Toolbar
    title={ws.current?.title ?? ''}
    {layout}
    {docsOpen}
    {settingsOpen}
    onrename={(t) => ws.rename(t)}
    onlayout={setLayout}
    ontoggledocs={() => (docsOpen = !docsOpen)}
    ontogglesettings={() => (settingsOpen = !settingsOpen)}
  />

  <div class="body">
    {#if docsOpen}
      <DocumentList
        docs={ws.docs}
        currentId={ws.current?.id}
        onopen={(id) => void ws.open(id)}
        oncreate={() => void ws.create()}
        ondelete={(id) => void ws.remove(id)}
      />
    {/if}

    <main class="panes layout-{layout}">
      {#if ws.ready}
        {#if layout !== 'preview'}
          <div class="pane">
            <Editor
              bind:this={editor}
              docId={ws.current?.id}
              text={ws.text}
              onchange={(t) => ws.setText(t)}
            />
          </div>
        {/if}
        {#if layout !== 'editor'}
          <div class="pane preview-pane">
            <Preview text={ws.text} />
          </div>
        {/if}
      {:else}
        <div class="loading">Opening…</div>
      {/if}
    </main>

    {#if settingsOpen}
      <SettingsPanel store={settings} onclose={() => (settingsOpen = false)} />
    {/if}
  </div>

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
</style>
