<script lang="ts">
  import type { Workspace } from '../docs/workspace.svelte';

  /**
   * Connects the shared folder to a git repository (git-sync.md §6). Shoulder asks only for the
   * repository's address: git signs in with whatever this Mac already uses.
   */
  let { ws, onclose }: { ws: Workspace; onclose: () => void } = $props();

  const GUIDE = 'https://github.com/CrumpLabSandbox/shoulder-md/blob/main/docs/git-sync-setup.md';

  let url = $state('');
  let rename = $state(false);
  let busy = $state(false);
  let error = $state<string | undefined>(undefined);
  let choice = $state(false);
  let done = $state<string | undefined>(undefined);

  const folderName = $derived(ws.folder.status === 'connected' ? ws.folder.name : '');
  /** The repository's own name, from its address, when it differs from the folder's. */
  const repo = $derived(
    url
      .trim()
      .replace(/\/+$/, '')
      .split(/[/:]/)
      .at(-1)
      ?.replace(/\.git$/, '') ?? '',
  );
  const offerRename = $derived(!!repo && !!folderName && repo !== folderName);

  async function run(combine = false) {
    if (!url.trim() || busy) return;
    busy = true;
    error = undefined;
    const r = await ws.setupGit(url, { rename: offerRename && rename, combine });
    busy = false;
    if (r.ok) {
      choice = false;
      done = r.notice ?? '';
    } else if (r.needsChoice) choice = true;
    else error = r.error;
  }
</script>

<div class="backdrop" role="presentation" onclick={onclose}></div>
<div class="dialog" role="dialog" aria-modal="true" aria-label="Sync between Macs">
  <h2>Sync between Macs</h2>
  {#if done !== undefined}
    <p>
      “{ws.folder.status === 'connected' ? ws.folder.name : 'The folder'}” now syncs with the
      repository. Shoulder pulls when it opens, when you come back to it, and every few minutes, and
      pushes shortly after your changes.
    </p>
    {#if done}<p class="warn">{done}</p>{/if}
    <div class="buttons">
      <button class="primary" onclick={onclose}>Done</button>
    </div>
  {:else if choice}
    <p>
      The repository already has documents, and so does this Mac’s folder. Shoulder will not merge
      two libraries without asking.
    </p>
    <p class="hint">
      Combining adds the repository’s documents to this folder and this Mac’s documents to the
      repository. Where the same file differs, this Mac’s version is kept and the other is saved
      beside it.
    </p>
    {#if error}<p class="warn">{error}</p>{/if}
    <div class="buttons">
      <button class="primary" disabled={busy} onclick={() => void run(true)}
        >{busy ? 'Combining…' : 'Combine them'}</button
      >
      <button disabled={busy} onclick={onclose}>Cancel</button>
    </div>
  {:else}
    <p>
      Keep <b>{folderName || 'your shared folder'}</b> the same on each of your Macs through a private
      git repository. Shoulder uses this Mac’s git and its existing sign-in; it never asks for a password
      or token.
    </p>
    <label>
      Repository address
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        bind:value={url}
        placeholder="https://github.com/you/ShoulderDocs.git"
        spellcheck="false"
        autocomplete="off"
        autofocus
        onkeydown={(e) => e.key === 'Enter' && void run()}
      />
    </label>
    <p class="hint">
      Make an empty private repository first. <a href={GUIDE} target="_blank" rel="noreferrer"
        >How do I make one, and sign in?</a
      >
    </p>
    {#if offerRename}
      <label class="check">
        <input type="checkbox" bind:checked={rename} />
        Rename the folder to match (“{repo}”)
      </label>
    {/if}
    {#if error}<p class="warn">{error}</p>{/if}
    <div class="buttons">
      <button class="primary" disabled={busy || !url.trim()} onclick={() => void run()}
        >{busy ? 'Setting up…' : 'Set Up'}</button
      >
      <button disabled={busy} onclick={onclose}>Not Now</button>
    </div>
  {/if}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: rgba(0, 0, 0, 0.25);
  }
  .dialog {
    position: fixed;
    z-index: 31;
    top: 12vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(460px, calc(100vw - 32px));
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 18px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-elev);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
    font-size: 13px;
  }
  h2 {
    margin: 0;
    font-size: 15px;
  }
  p {
    margin: 0;
    line-height: 1.45;
  }
  .hint {
    color: var(--fg-muted);
    font-size: 12px;
  }
  .warn {
    color: #b45309;
    font-size: 12px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    font-weight: 600;
  }
  label.check {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    font-weight: normal;
  }
  input[type='text'] {
    font: inherit;
    font-size: 13px;
    font-weight: normal;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
  }
  .buttons {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .buttons button {
    border: 1px solid var(--border);
    padding: 4px 12px;
  }
  .buttons .primary {
    background: var(--accent);
    color: white;
    border-color: transparent;
  }
  .buttons button:disabled {
    opacity: 0.6;
  }
</style>
