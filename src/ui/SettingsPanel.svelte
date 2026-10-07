<script lang="ts">
  import { FONTS, ROLE_LABELS, type FontRole } from '../settings/fonts';
  import { PRESETS, type SettingsStore, type Theme } from '../settings/settings.svelte';

  import { AUTHOR_PALETTE } from '../docs/identity';
  import type { FolderStatus } from '../docs/workspace.svelte';
  import type { FolderKind } from '../persist/idb';
  import type { Author } from '../model/types';

  let {
    store,
    author,
    onauthor,
    onclose,
    folder,
    privateFolder,
    privateUnsynced,
    onconnectfolder,
    onreconnectfolder,
    ondisconnectfolder,
  }: {
    store: SettingsStore;
    author: Author;
    onauthor: (a: Author) => void;
    onclose: () => void;
    folder: FolderStatus;
    privateFolder: FolderStatus;
    /** Documents with Claude off that no folder holds, because no private folder is set. */
    privateUnsynced: number;
    onconnectfolder: (kind: FolderKind) => void;
    onreconnectfolder: (kind: FolderKind) => void;
    ondisconnectfolder: (kind: FolderKind) => void;
  } = $props();
  const s = $derived(store.value);

  const roles: FontRole[] = ['serif', 'sans', 'mono', 'duospace'];
  const themes: { id: Theme; label: string }[] = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'sepia', label: 'Sepia' },
  ];
</script>

{#snippet controls(f: FolderStatus, kind: FolderKind)}
  {#if f.status === 'connected'}
    <p class="note">Syncing to <b>{f.name}</b>.</p>
    <div class="row-buttons">
      <button onclick={() => onconnectfolder(kind)}>Change folder…</button>
      <button onclick={() => ondisconnectfolder(kind)}>Stop syncing</button>
    </div>
  {:else if f.status === 'needs-permission' || f.status === 'error'}
    <p class="note">
      “{f.name}” needs your permission again{f.status === 'error' ? ` (${f.error})` : ''}.
    </p>
    <div class="row-buttons">
      <button onclick={() => onreconnectfolder(kind)}>Reconnect</button>
      <button onclick={() => ondisconnectfolder(kind)}>Stop syncing</button>
    </div>
  {:else}
    <div class="row-buttons">
      <button onclick={() => onconnectfolder(kind)}
        >{kind === 'private' ? 'Choose a private folder…' : 'Choose a folder…'}</button
      >
    </div>
  {/if}
{/snippet}

<aside class="settings no-print" aria-label="Settings">
  <div class="head">
    <span>Appearance</span>
    <button onclick={onclose} aria-label="Close settings">×</button>
  </div>

  <section>
    <h3>Preset</h3>
    <div class="presets">
      {#each PRESETS as p (p.id)}
        <button
          class:active={s.preset === p.id}
          onclick={() => store.usePreset(p.id)}
          title={p.description}
        >
          {p.label}
        </button>
      {/each}
      {#if s.preset === 'custom'}
        <button class="active" disabled>Custom</button>
      {/if}
    </div>
  </section>

  <section>
    <h3>Fonts</h3>
    <label>
      <span>Editor</span>
      <select value={s.editorFont} onchange={(e) => store.set('editorFont', e.currentTarget.value)}>
        {#each roles as role (role)}
          <optgroup label={ROLE_LABELS[role]}>
            {#each FONTS.filter((f) => f.role === role) as f (f.id)}
              <option value={f.id}>{f.label}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </label>
    <label>
      <span>Preview</span>
      <select
        value={s.previewFont}
        onchange={(e) => store.set('previewFont', e.currentTarget.value)}
      >
        {#each roles as role (role)}
          <optgroup label={ROLE_LABELS[role]}>
            {#each FONTS.filter((f) => f.role === role) as f (f.id)}
              <option value={f.id}>{f.label}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </label>
    <div class="samples">
      {#each FONTS as f (f.id)}
        <div class="sample" style:font-family={f.stack}>
          {f.label}: The quick brown fox jumps over the lazy dog.
        </div>
      {/each}
    </div>
  </section>

  <section>
    <h3>Type</h3>
    <label>
      <span>Size <output>{s.fontSize}px</output></span>
      <input
        type="range"
        min="12"
        max="24"
        step="1"
        value={s.fontSize}
        oninput={(e) => store.set('fontSize', Number(e.currentTarget.value))}
      />
    </label>
    <label>
      <span>Line height <output>{s.lineHeight.toFixed(2)}</output></span>
      <input
        type="range"
        min="1.2"
        max="2"
        step="0.05"
        value={s.lineHeight}
        oninput={(e) => store.set('lineHeight', Number(e.currentTarget.value))}
      />
    </label>
    <label>
      <span>Text width <output>{s.measure === 0 ? 'full' : `${s.measure}ch`}</output></span>
      <input
        type="range"
        min="50"
        max="100"
        step="2"
        value={s.measure === 0 ? 100 : s.measure}
        disabled={s.measure === 0}
        oninput={(e) => store.set('measure', Number(e.currentTarget.value))}
      />
    </label>
    <label class="row">
      <input
        type="checkbox"
        checked={s.measure === 0}
        onchange={(e) => store.set('measure', e.currentTarget.checked ? 0 : 72)}
      />
      <span>Full width</span>
    </label>
  </section>

  <section>
    <h3>Theme</h3>
    <div class="presets">
      {#each themes as t (t.id)}
        <button class:active={s.theme === t.id} onclick={() => store.set('theme', t.id)}
          >{t.label}</button
        >
      {/each}
    </div>
  </section>

  <section>
    <h3>Folder</h3>
    {#if folder.status === 'unsupported'}
      <p class="note">
        Saving to a folder needs Chrome or Edge. Documents are still saved in this browser.
      </p>
    {:else}
      <p class="note">
        Mirror every document Claude may read into a folder as <code>.md</code> and
        <code>.shoulder.json</code>, for git or Claude Code. Edits made to those files elsewhere
        come back as tracked changes.
      </p>
      {@render controls(folder, 'shared')}
      <h4>Private folder</h4>
      <p class="note">
        Documents with Claude off go here instead, so Claude Code never sees them. Keep it outside
        the shared folder.
      </p>
      {#if privateUnsynced > 0 && privateFolder.status !== 'connected'}
        <p class="note warn">
          {privateUnsynced}
          {privateUnsynced === 1 ? 'document has' : 'documents have'} Claude off and {privateUnsynced ===
          1
            ? 'is'
            : 'are'} saved only in this browser.
        </p>
      {/if}
      {@render controls(privateFolder, 'private')}
    {/if}
  </section>

  <section>
    <h3>Changes</h3>
    <label class="row">
      <input
        type="checkbox"
        checked={s.showReasonTags}
        onchange={(e) => store.set('showReasonTags', e.currentTarget.checked)}
      />
      <span>Show reason tags on change cards</span>
    </label>
    <label class="row">
      <input
        type="checkbox"
        checked={s.showReasonField}
        onchange={(e) => store.set('showReasonField', e.currentTarget.checked)}
      />
      <span>Show the “Why?” field on change cards</span>
    </label>
  </section>

  <section>
    <h3>Identity</h3>
    <label>
      <span>Your name (on changes and comments)</span>
      <input
        type="text"
        value={author.name}
        onchange={(e) => onauthor({ ...author, name: e.currentTarget.value.trim() || 'Me' })}
      />
    </label>
    <div class="swatches" role="group" aria-label="Author colour">
      {#each AUTHOR_PALETTE as c (c)}
        <button
          class="swatch"
          class:on={author.color === c}
          style:background={c}
          aria-label="Colour {c}"
          onclick={() => onauthor({ ...author, color: c })}
        ></button>
      {/each}
    </div>
  </section>

  <section class="foot">
    <button onclick={() => store.reset()}>Reset to defaults</button>
  </section>
</aside>

<style>
  .settings {
    width: 300px;
    flex: none;
    border-left: 1px solid var(--border);
    background: var(--bg-elev);
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 10px;
    font-weight: 600;
    border-bottom: 1px solid var(--border);
  }
  section {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  h3 {
    margin: 0;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-muted);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  label > span {
    display: flex;
    justify-content: space-between;
    color: var(--fg-muted);
  }
  label.row {
    flex-direction: row;
    align-items: center;
    gap: 6px;
  }
  output {
    color: var(--fg);
    font-variant-numeric: tabular-nums;
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--accent);
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .presets button {
    border: 1px solid var(--border);
  }
  .samples {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--fg-muted);
    margin-top: 4px;
  }
  .sample {
    line-height: 1.4;
  }
  .note {
    margin: 0;
    font-size: 12px;
    color: var(--fg-muted);
    line-height: 1.45;
  }
  h4 {
    margin: 6px 0 0;
    font-size: 12px;
    font-weight: 600;
  }
  .note.warn {
    color: #b45309;
  }
  .row-buttons {
    display: flex;
    gap: 6px;
  }
  .row-buttons button {
    border: 1px solid var(--border);
  }
  .swatches {
    display: flex;
    gap: 6px;
  }
  .swatch {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid transparent;
    padding: 0;
  }
  .swatch.on {
    border-color: var(--fg);
  }
  .foot {
    border-bottom: 0;
    margin-top: auto;
  }
</style>
