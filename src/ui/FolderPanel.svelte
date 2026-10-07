<script lang="ts">
  import type { FolderStatus, Workspace } from '../docs/workspace.svelte';
  import type { FolderKind } from '../persist/idb';

  /** Where documents are kept on disk: the shared folder and the private folder. */
  let { ws }: { ws: Workspace } = $props();

  const n = $derived(ws.privateUnsynced);
</script>

{#snippet controls(f: FolderStatus, kind: FolderKind)}
  {#if f.status === 'connected'}
    <p class="state">Syncing to <b>{f.name}</b></p>
    <div class="buttons">
      <button onclick={() => void ws.connectFolder(kind)}>Change folder…</button>
      <button onclick={() => void ws.disconnectFolder(kind)}>Stop syncing</button>
    </div>
  {:else if f.status === 'needs-permission' || f.status === 'error'}
    <p class="state warn">
      “{f.name}” needs your permission again{f.status === 'error' ? ` (${f.error})` : ''}.
    </p>
    <div class="buttons">
      <button onclick={() => void ws.reconnectFolder(kind)}>Reconnect</button>
      <button onclick={() => void ws.disconnectFolder(kind)}>Stop syncing</button>
    </div>
  {:else}
    <p class="state">Not set</p>
    <div class="buttons">
      <button onclick={() => void ws.connectFolder(kind)}
        >{kind === 'private' ? 'Choose a private folder…' : 'Choose a folder…'}</button
      >
    </div>
  {/if}
{/snippet}

<div class="panel folders" aria-label="Folders">
  <h2>Folders</h2>
  {#if ws.folder.status === 'unsupported'}
    <p class="hint">
      Saving to a folder needs Chrome, Edge, or the Mac app. Documents are still saved here.
    </p>
  {:else}
    <div class="pair">
      <section>
        <h3>Shared folder</h3>
        <p class="hint">
          Every document Claude may read is mirrored here, each in its own folder under
          <code>Documents</code>. Style guides go in <code>Style/Guides</code>, and
          <code>Style/Samples</code> is for examples of your own writing, one folder per genre. Edits
          made to a document's files elsewhere come back as tracked changes.
        </p>
        {@render controls(ws.folder, 'shared')}
      </section>
      <section>
        <h3>Private folder</h3>
        <p class="hint">
          Documents with Claude off go here instead, in the same layout, so Claude Code never sees
          them. Keep it outside the shared folder.
        </p>
        {#if n > 0 && ws.privateFolder.status !== 'connected'}
          <p class="state warn">
            {n}
            {n === 1 ? 'document has' : 'documents have'} Claude off and {n === 1 ? 'is' : 'are'} not
            saved to any folder.
          </p>
        {/if}
        {@render controls(ws.privateFolder, 'private')}
      </section>
    </div>
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
  h2 {
    margin: 0;
    font-size: 15px;
  }
  h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .hint,
  .state {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
  }
  .hint {
    color: var(--fg-muted);
  }
  .state.warn {
    color: #b45309;
  }
  .buttons {
    display: flex;
    gap: 6px;
  }
  .buttons button {
    border: 1px solid var(--border);
    padding: 4px 10px;
  }
  @media (max-width: 720px) {
    .pair {
      grid-template-columns: 1fr;
    }
  }
</style>
