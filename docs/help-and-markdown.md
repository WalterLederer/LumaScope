# Help search and Markdown rendering

This page documents the in-app Help search and the Markdown processing used by LumaScope. It is intended for contributors who maintain the Help pages as well as users who want to understand the search controls.

## Search all Help pages

The search field at the top of the Help view searches the text of every Markdown document registered in the Help page list. Enter at least two characters to start a search. Results are grouped by document and show the matching line number and a short text excerpt.

- Select a result to open its document and jump to the matching line.
- Use **Next** and **Previous** to move through all results, including results on other pages. Navigation wraps at the beginning and end.
- Press **F3** for the next result and **Shift+F3** for the previous result. These shortcuts remain available when focus is in the Help article or the results panel.
- Press **Enter** in the search field to move to the next result; use **Shift+Enter** for the previous result.
- Matching text remains highlighted in yellow. The currently selected destination receives an additional accent-colour highlight so it can be distinguished from the other matches.
- The search-results pane and the Help article have independent scrolling. Drag the separator between them to change their relative heights.
- Clear the search field to close the results pane. The search is case-insensitive and searches the Markdown source text, not only the currently rendered page.

The searchable page list is maintained in `helpDocuments` in `apps/web/src/ui/components/markdown-viewer/markdown-viewer.component.ts`. When adding a new Help document, add its filename there as well as adding the file under `docs/`. This list is used both for the sitemap and for searching all pages.

## How Markdown is converted for the app

LumaScope does not run a general-purpose Markdown package in the Help view. The renderer is implemented in `markdown-viewer.component.ts` and converts the source text into HTML before displaying it in the Angular article.

The processing flow is:

1. **Load the source.** The desktop file-system IPC reads the selected Markdown document. `README.md` is loaded from the documentation root; other allowlisted documents are loaded from `docs/`.
2. **Resolve local images.** Image references are collected from the Markdown source. Only supported local image names in the documentation image folders are requested through the documentation-image IPC. The renderer replaces those references with the returned image data. A missing or unsupported image is represented by its alternative text.
3. **Split into source lines.** Line endings are normalized and the document is split into individual lines. The renderer processes headings, fenced code blocks, horizontal rules, tables, unordered and ordered lists, blockquotes and paragraphs.
4. **Convert inline Markdown.** The inline renderer handles code spans, bold and italic text, images and links. External HTTP(S) links are opened separately; relative links are handled by the Help viewer and restricted to allowlisted Markdown documents.
5. **Add search highlighting and navigation anchors.** Search matches are wrapped in `mark.markdown-search-hit`. Source-line anchors and line classes let search results navigate to the corresponding location, including within multi-line paragraphs, code blocks, lists and tables.
6. **Display sanitized HTML.** The generated HTML is assigned to Angular's `[innerHTML]`. Angular sanitization remains enabled; the renderer uses CSS classes rather than relying on HTML `id` attributes for search anchors, because sanitization removes those IDs.

### Markdown supported by the in-app renderer

| Markdown source | In-app rendering |
| --- | --- |
| `# Heading` through `###### Heading` | HTML headings (H1–H6) |
| Blank-line-separated text | Paragraphs; consecutive source lines in a paragraph are separated by line breaks |
| `**bold**`, `*italic*`, `\`code\`` | Strong, emphasis and inline code |
| `- item`, `1. item` | Unordered and ordered lists |
| `> quote` | Blockquote |
| `---` | Horizontal rule |
| Pipe-delimited rows with a separator row | HTML table |
| Fenced blocks using three backticks | Preformatted code block; the optional language is retained as a CSS class |
| `[label](target)` | Link; external HTTP(S) targets open separately |
| `![alt](image.png)` and supported local `<img>` tags | Local documentation images, when the image is available through the documentation-image loader |

This is a deliberately small renderer for the syntax used by the project's Help pages. It is not a complete CommonMark implementation: advanced nested Markdown, reference-style links, complex inline HTML and arbitrary embedded content should not be assumed to work.

### Adding or editing a Help page

1. Create or edit the Markdown file in `docs/`.
2. Add its filename to the `helpDocuments` array in `markdown-viewer.component.ts`. Use the filename only, including the `.md` extension.
3. Add a link to the page in the Documentation section of the root `README.md`, so the page is discoverable from the project documentation as well.
4. Store local images in the documentation image directory and reference them using the relative path convention used by the neighbouring Help pages. Keep image filenames within the supported character set.
5. Preview the page in the app's Help view. Check headings, lists, tables, links, images and search navigation to ensure the source lines still point to the expected rendered content.

The Help page allowlist is intentional. A relative Markdown link cannot cause the application to load an arbitrary local file.
