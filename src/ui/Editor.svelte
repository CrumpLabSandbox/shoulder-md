<script lang="ts">
  import { onMount } from 'svelte';
  import { createEditor, type EditorHandle } from '../editor/createEditor';

  let {
    docId,
    text,
    onchange,
  }: { docId: string | undefined; text: string; onchange: (text: string) => void } = $props();

  let host: HTMLDivElement;
  let editor: EditorHandle | undefined;
  let loadedDocId: string | undefined;

  onMount(() => {
    editor = createEditor({ parent: host, doc: text, onChange: onchange });
    loadedDocId = docId;
    editor.focus();
    return () => editor?.destroy();
  });

  // When the open document changes, replace the buffer (and reset undo history).
  $effect(() => {
    if (!editor) return;
    if (docId !== loadedDocId) {
      editor.setText(text);
      loadedDocId = docId;
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
