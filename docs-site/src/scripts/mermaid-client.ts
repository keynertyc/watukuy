/**
 * Renders <pre class="mermaid"> blocks (emitted by scripts/sync-docs.mjs from ```mermaid fences)
 * into inline SVG in the browser, and re-renders when the Starlight theme toggles so the diagram
 * palette follows light/dark mode. Mermaid is imported lazily, so pages without diagrams never
 * download it.
 */

const SELECTOR = 'pre.mermaid';

function currentTheme(): 'dark' | 'default' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
}

export async function renderMermaidBlocks(): Promise<void> {
  const blocks = Array.from(document.querySelectorAll<HTMLPreElement>(SELECTOR));
  if (blocks.length === 0) return;

  // Keep the source text: after the first render the element contains SVG, not the diagram.
  for (const block of blocks) {
    block.dataset.source ??= block.textContent ?? '';
  }

  const { default: mermaid } = await import('mermaid');
  let generation = 0;

  const render = async (): Promise<void> => {
    const run = ++generation;
    mermaid.initialize({ startOnLoad: false, theme: currentTheme(), securityLevel: 'strict' });
    for (const [index, block] of blocks.entries()) {
      const source = block.dataset.source ?? '';
      try {
        const { svg } = await mermaid.render(`watukuy-mermaid-${run}-${index}`, source);
        if (run !== generation) return; // a theme change started a newer render
        block.innerHTML = svg;
        block.dataset.processed = 'true';
      } catch (error) {
        console.error('[watukuy docs] mermaid render failed', error);
        block.textContent = source; // leave the diagram source readable
      }
    }
  };

  await render();

  new MutationObserver(() => {
    void render();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
