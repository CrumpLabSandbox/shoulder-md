<script lang="ts">
  import { onMount } from 'svelte';
  import { createEditor, type EditorBridge } from '../editor/createEditor';
  import type { Workspace } from '../docs/workspace.svelte';
  import { flatten, keptText, onlyPendingDeletions } from '../model/spans';

  let { ws, onscroll }: { ws: Workspace; onscroll?: () => void } = $props();

  let host: HTMLDivElement;
  let bridge: EditorBridge | undefined;
  let loadedKey: string | undefined;

  onMount(() => {
    bridge = createEditor({
      parent: host,
      doc: ws.text,
      onTransaction: (tr) => ws.applyTransaction(tr),
      onSelection: (sel) => ws.setCursor(sel),
      onUndo: () => ws.undo(),
      onRedo: () => ws.redo(),
      tracking: {
        isTracking: () => ws.trackingOn,
        keptText: (from, to) =>
          ws.current ? keptText(flatten(ws.current.state.blocks), from, to, ws.author.id) : '',
        onlyPendingDeletions: (from, to) =>
          ws.current ? onlyPendingDeletions(flatten(ws.current.state.blocks), from, to) : false,
      },
    });
    loadedKey = `${ws.current?.id}:${ws.version}`;
    ws.attachEditor(bridge);
    const off = onscroll ? bridge.onScroll(onscroll) : undefined;
    bridge.focus();
    return () => {
      off?.();
      ws.attachEditor(undefined);
      bridge?.destroy();
    };
  });

  // When the open document (or the resync version) changes, replace the buffer.
  $effect(() => {
    if (!bridge) return;
    const key = `${ws.current?.id}:${ws.version}`;
    if (key !== loadedKey) {
      bridge.setText(ws.text, { readOnly: ws.view !== 'revision' });
      loadedKey = key;
      ws.attachEditor(bridge);
      bridge.focus();
    }
  });

  export function focus() {
    bridge?.focus();
  }

  export function measureTop(pos: number): number | undefined {
    return bridge?.measureTop(pos);
  }
</script>

<div class="editor-host" bind:this={host}></div>

<style>
  .editor-host {
    height: 100%;
    min-height: 0;
  }
</style>
