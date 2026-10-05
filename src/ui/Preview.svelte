<script lang="ts">
  import { renderMarkdown } from '../preview/render';

  let { text }: { text: string } = $props();
  const html = $derived(renderMarkdown(text));
</script>

<div class="preview-scroll">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- output is sanitized by DOMPurify in renderMarkdown -->
  <article class="md-preview">{@html html}</article>
</div>

<style>
  .preview-scroll {
    height: 100%;
    overflow: auto;
  }
</style>
