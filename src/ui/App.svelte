<script lang="ts">
  import { appBridge } from '../app/bridge';
  import { inTextField, runMenuCommand, type MenuActions } from '../app/commands';
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
  import Library from './Library.svelte';
  import AccessMenu from './AccessMenu.svelte';
  import ClaudePanel from './ClaudePanel.svelte';
  import ChatPanel from './ChatPanel.svelte';
  import GuideBanner from './GuideBanner.svelte';

  const settings = createSettingsStore();
  const ws = createWorkspace(loadAuthor(), {
    libraryDefault: () => settings.value.libraryDefault,
    saveChats: () => settings.value.saveChats,
  });

  let docsOpen = $state(false);
  let settingsOpen = $state(false);
  let marginOpen = $state(true);
  let libraryOpen = $state(false);
  let editor: Editor | undefined = $state();
  let tick = $state(0);

  const layout = $derived(settings.value.layout);
  const showMargin = $derived(
    marginOpen && !libraryOpen && layout !== 'preview' && ws.view === 'revision',
  );

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
    void settings.value.showReasonTags;
    void settings.value.showReasonField;
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
        KeyL: () => (libraryOpen = !libraryOpen),
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

  /** What each menu command of the Mac app does (see app/commands.ts). */
  const menuActions: MenuActions = {
    settings: () => (settingsOpen = !settingsOpen),
    new: () => void ws.create(),
    import: () => importInput?.click(),
    'insert-image': () => imageInput?.click(),
    documents: () => (docsOpen = !docsOpen),
    library: () => (libraryOpen = !libraryOpen),
    save: () => void ws.flush(),
    folder: () => void ws.connectFolder('shared'),
    'folder-private': () => void ws.connectFolder('private'),
    'export:md-clean': () => void ws.exportAs('md-clean'),
    'export:md-original': () => void ws.exportAs('md-original'),
    'export:md-critic': () => void ws.exportAs('md-critic'),
    'export:docx': () => void ws.exportAs('docx'),
    'export:json': () => void ws.exportAs('json'),
    'export:print-clean': () => void ws.exportAs('print-clean'),
    'export:print-markup': () => void ws.exportAs('print-markup'),
    // In a text field (a title, a reason) Undo belongs to the field, as it does in a browser.
    undo: () => (inTextField(document.activeElement) ? document.execCommand('undo') : ws.undo()),
    redo: () => (inTextField(document.activeElement) ? document.execCommand('redo') : ws.redo()),
    'view:revision': () => ws.setView('revision'),
    'view:clean': () => ws.setView('clean'),
    'view:original': () => ws.setView('original'),
    'layout:editor': () => setLayout('editor'),
    'layout:split': () => setLayout(layout === 'split' ? 'editor' : 'split'),
    'layout:preview': () => setLayout(layout === 'preview' ? 'editor' : 'preview'),
    margin: () => (marginOpen = !marginOpen),
    tracking: () => ws.toggleTracking(),
    accept: () => void ws.acceptActive(),
    reject: () => void ws.rejectActive(),
    next: () => ws.nextChange(),
    previous: () => ws.prevChange(),
    'accept-all': () => ws.acceptAll(),
    'reject-all': () => ws.rejectAll(),
    'ask-claude': () => (claudeOpen = true),
    chat: () => (chatOpen = !chatOpen),
    'draft-principles': () => (claudeOpen = true),
    reason: () => focusReason(),
    comment: () => {
      marginOpen = true;
      ws.startComment();
    },
  };
  let importInput: HTMLInputElement | undefined = $state();
  let imageInput: HTMLInputElement | undefined = $state();
  let claudeOpen = $state(false);
  let chatOpen = $state(false);
  const inApp = !!appBridge();

  function focusReason() {
    const id = ws.activeChangeId;
    if (!id) return;
    marginOpen = true;
    ws.requestReason(id);
  }

  onMount(() => {
    void ws.init();
    void requestPersistence();
    const detach = attachFlushTriggers(() => ws.flush());
    const onResize = () => tick++;
    window.addEventListener('resize', onResize);
    const stopMenu = appBridge()?.onMenu((command) => runMenuCommand(menuActions, command));
    return () => {
      stopMenu?.();
      detach();
      window.removeEventListener('resize', onResize);
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<!-- File > Insert Image… in the Mac app; images can also be dropped or pasted into the editor. -->
<input
  bind:this={imageInput}
  type="file"
  accept="image/*"
  hidden
  onchange={(e) => {
    const f = e.currentTarget.files?.[0];
    if (f) void ws.addImage(f);
    e.currentTarget.value = '';
  }}
/>

<!-- File > Import… in the Mac app; the Documents panel has its own button. -->
<input
  bind:this={importInput}
  type="file"
  accept=".md,.markdown,.txt,.json"
  hidden
  onchange={(e) => {
    const f = e.currentTarget.files?.[0];
    if (f) void ws.importFile(f);
    e.currentTarget.value = '';
  }}
/>

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
    {libraryOpen}
    ontogglelibrary={() => (libraryOpen = !libraryOpen)}
  >
    {#snippet access()}
      {#if ws.ready && ws.current}
        <AccessMenu
          {ws}
          onaskclaude={inApp ? () => (claudeOpen = true) : undefined}
          onchat={inApp ? () => (chatOpen = true) : undefined}
        />
      {/if}
    {/snippet}
  </Toolbar>

  {#if ws.ready && ws.currentGuide && !libraryOpen}
    <GuideBanner {ws} ondraft={inApp ? () => (claudeOpen = true) : undefined} />
  {/if}

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

    {#if libraryOpen && ws.ready}
      <Library
        {ws}
        libraryDefault={settings.value.libraryDefault}
        onlibrarydefault={(v) => settings.set('libraryDefault', v)}
        onopen={(id) => {
          libraryOpen = false;
          void ws.open(id);
        }}
        onclose={() => (libraryOpen = false)}
      />
    {:else}
      <main class="panes layout-{layout}">
        {#if ws.ready}
          {#if layout !== 'preview'}
            <div class="pane">
              <Editor bind:this={editor} {ws} onscroll={() => tick++} />
            </div>
          {/if}
          {#if layout !== 'editor'}
            <div class="pane preview-pane">
              <Preview
                text={ws.current ? ws.displayText : ''}
                resolve={(ref) => ws.assetUrl(ref)}
              />
            </div>
          {/if}
        {:else}
          <div class="loading">Opening…</div>
        {/if}
      </main>
    {/if}

    {#if showMargin && ws.ready}
      <Margin
        {ws}
        measure={(pos) => editor?.measureTop(pos)}
        {tick}
        showTags={settings.value.showReasonTags}
        ontoggletags={(v) => settings.set('showReasonTags', v)}
        showReason={settings.value.showReasonField}
        ontogglereason={(v) => settings.set('showReasonField', v)}
      />
    {/if}

    {#if chatOpen && inApp && ws.ready && !libraryOpen}
      <ChatPanel
        {ws}
        model={settings.value.claudeModel}
        onmodel={(m) => settings.set('claudeModel', m)}
        onclose={() => (chatOpen = false)}
      />
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

  {#if claudeOpen || ws.claudeRun}
    <ClaudePanel
      {ws}
      model={settings.value.claudeModel}
      onmodel={(m) => settings.set('claudeModel', m)}
      onclose={() => (claudeOpen = false)}
    />
  {/if}

  {#if ws.external}
    {@const ext = ws.external.ext}
    <div class="notice external" role="alert">
      <span>
        {#if ext.kind === 'md'}
          <b>{ext.file}</b> was edited outside the app.
        {:else if ext.kind === 'json' && ext.extendsLocal}
          <b>{ext.file}</b> has {ext.newOps} new {ext.newOps === 1 ? 'operation' : 'operations'} from
          another tool.
        {:else if ext.kind === 'json'}
          <b>{ext.file}</b> on disk has a different history from this document.
        {:else}
          <b>{ext.file}</b> could not be read ({ext.error}).
        {/if}
      </span>
      <span class="actions">
        {#if ext.kind === 'md'}
          <button class="primary" onclick={() => void ws.resolveExternal('disk')}
            >Load as tracked changes</button
          >
        {:else if ext.kind === 'json' && ext.extendsLocal}
          <button class="primary" onclick={() => void ws.resolveExternal('disk')}>Load them</button>
        {:else if ext.kind === 'json'}
          <button onclick={() => void ws.resolveExternal('disk')}>Use the disk version</button>
        {/if}
        <button onclick={() => void ws.resolveExternal('mine')}
          >{ext.kind === 'invalid' ? 'Overwrite with my version' : 'Keep my version'}</button
        >
      </span>
    </div>
  {/if}

  {#if ws.proposalOffer && !ws.external}
    {@const n = ws.proposalOffer.proposals.length}
    <div class="notice external" role="alert">
      <span>
        Claude proposed {n}
        {n === 1 ? 'edit' : 'edits'} for this document (<b>{ws.proposalOffer.file}</b>).
      </span>
      <span class="actions">
        <button class="primary" onclick={() => void ws.applyProposals()}
          >Show as tracked changes</button
        >
        <button onclick={() => void ws.discardProposals()}>Discard</button>
      </span>
    </div>
  {/if}

  {#if ws.suggestionOffer && !ws.external}
    {@const n = ws.suggestionOffer.principles.length}
    <div class="notice external" role="alert">
      <span>
        Claude suggested {n}
        {n === 1 ? 'principle' : 'principles'} for this guide, from your samples.
      </span>
      <span class="actions">
        <button class="primary" onclick={() => void ws.applySuggestions()}
          >Show as tracked changes</button
        >
        <button onclick={() => void ws.discardSuggestions()}>Discard</button>
      </span>
    </div>
  {/if}

  {#if ws.revisionOffer && !ws.external}
    <div class="notice external" role="alert">
      <span>
        Claude wrote a revised version of this document{ws.revisionOffer.reason
          ? `: ${ws.revisionOffer.reason}`
          : '.'}
      </span>
      <span class="actions">
        <button class="primary" onclick={() => void ws.applyRevision()}
          >Show as tracked changes</button
        >
        <button onclick={() => void ws.discardRevision()}>Discard</button>
      </span>
    </div>
  {/if}

  {#if ws.folderNotice}
    <div class="notice" role="status">
      <span>{ws.folderNotice}</span>
      <button onclick={() => ws.clearFolderNotice()} aria-label="Dismiss">×</button>
    </div>
  {/if}

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
    folder={ws.folder}
    onconnect={() => void ws.connectFolder()}
    onreconnect={() => void ws.reconnectFolder()}
    privateFolder={ws.privateFolder}
    onreconnectprivate={() => void ws.reconnectFolder('private')}
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
  .notice.external {
    background: color-mix(in srgb, var(--accent) 14%, var(--bg-elev));
  }
  .notice .actions {
    display: flex;
    gap: 6px;
  }
  .notice .actions button {
    border: 1px solid var(--border);
    font-size: 12px;
  }
</style>
