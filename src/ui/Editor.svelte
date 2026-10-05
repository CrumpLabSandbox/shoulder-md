<script lang="ts">
  import { onMount } from 'svelte';
  import { createEditor, type EditorHandle, type Transaction } from '../editor/createEditor';

  let {
    docId,
    text,
    version = 0,
    ontransaction,
  }: {
    docId: string | undefined;
    text: string;
    /** Bump to force the buffer to be replaced with `text` (resync after an external change). */
    version?: number;
    ontransaction: (tr: Transaction) => void;
  } = $props();

  let host: HTMLDivElement;
  let editor: EditorHandle | undefined;
  let loadedKey: string | undefined;

  onMount(() => {
    editor = createEditor({ parent: host, doc: text, onTransaction: ontransaction });
    loadedKey = `${docId}:${version}`;
    editor.focus();
    return () => editor?.destroy();
  });

  // When the open document (or the resync version) changes, replace the buffer and reset undo.
  $effect(() => {
    if (!editor) return;
    const key = `${docId}:${version}`;
    if (key !== loadedKey) {
      editor.setText(text);
      loadedKey = key;
      editor.focus();
    }
  });

  export function focus() {
    editor?.focus();
  }
</script>

<div class="editor-host" bind:this={host}></div>

<style>
  .editor-host {
    height: 100%;
    min-height: 0;
  }
</style>
