<script lang="ts">
  import { renderMarkdown } from '../preview/render';

  let {
    text,
    resolve,
  }: {
    text: string;
    /** Turns an image path from the Markdown (`assets/<name>`) into a URL the page can load. */
    resolve?: (ref: string) => Promise<string | undefined>;
  } = $props();
  const html = $derived(renderMarkdown(text));
  let article: HTMLElement | undefined = $state();

  // Images kept beside the document are not reachable by their relative path from the page.
  $effect(() => {
    void html;
    if (!article || !resolve) return;
    for (const img of article.querySelectorAll('img')) {
      const ref = img.getAttribute('src') ?? '';
      if (!ref.startsWith('assets/')) continue;
      void resolve(ref).then((url) => {
        if (url) img.src = url;
        else img.alt = img.alt || `Missing image: ${ref}`;
      });
    }
  });
</script>

<div class="preview-scroll">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- output is sanitized by DOMPurify in renderMarkdown -->
  <article class="md-preview" bind:this={article}>{@html html}</article>
</div>

<style>
  .preview-scroll {
    height: 100%;
    overflow: auto;
  }
  .md-preview :global(img) {
    max-width: 100%;
    height: auto;
  }
</style>
