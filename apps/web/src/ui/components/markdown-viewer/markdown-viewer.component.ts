import { DOCUMENT } from '@angular/common';
import { SliderComponent } from '@light-matter/ui';
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FileSystem } from '../../../ipc/file-system';
import { ProcessManager } from '../../../ipc/process-manager';

interface HelpSearchResult { fileName: string; lineNumber: number; snippet: string; }
interface HelpSearchGroup { fileName: string; title: string; results: HelpSearchResult[]; }

const helpDocuments = ['README.md', 'build-from-source.md', 'external-programs.md', 'features.md', 'gpx-cache.md', 'image-detail-table.md', 'image-formats.md', 'licensing.md', 'location-fix-automatic.md', 'location-fix-manual.md', 'map-formats.md', 'offline-address-search.md', 'ohsp-format.md', 'photo-markers-tab.md', 'platform-support.md', 'resource-package-format.md', 'routing.md', 'screen-capture-formats.md', 'screen-capture.md', 'shortcuts.md', 'time-slider-animation.md', 'time-slider.md', 'track-tab.md', 'windows-api.md'] as const;

const isDocumentationFile = (fileName: string): boolean => /^[a-zA-Z0-9_-]+\.md$/i.test(fileName);

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const imageWidthClass = (widthText?: string): string => {
  const width = widthText ? Number(widthText) : NaN;
  return Number.isFinite(width) && width > 0 && width <= 100
    ? ' class="markdown-image-width-' + width + '"'
    : '';
};

const renderInline = (source: string, imageSources: ReadonlyMap<string, string>, searchQuery = ''): string => {
  const htmlImages: string[] = [];
  const withImagePlaceholders = source.replace(/<img\b([^>]*)>/gi, (_match, attributes: string) => {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] ?? '';
    const widthText = /\bwidth\s*=\s*["']?(\d{1,3}(?:\.\d+)?)%?["']?/i.exec(attributes)?.[1];
    const imageSource = src ? imageSources.get(src) : undefined;
    const rendered = imageSource
      ? '<img src="' + imageSource + '" alt="' + escapeHtml(alt) + '" loading="lazy"' + imageWidthClass(widthText) + '>'
      : '<span>' + escapeHtml(alt) + '</span>';
    const token = '__LUMASCOPE_HTML_IMAGE_' + htmlImages.length + '__';
    htmlImages.push(rendered);
    return token;
  });
  let value = escapeHtml(withImagePlaceholders);
  if (searchQuery.trim()) {
    const escapedQuery = escapeHtml(Array.from(searchQuery.trim()).map(character => '.+*?^${}()|[]\\'.includes(character) ? '\\' + character : character).join(''));
    value = value.replace(new RegExp(escapedQuery, 'gi'), match => '<mark class="markdown-search-hit">' + match + '</mark>');
  }
  value = value.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  value = value.replace(/!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))+(?:\s+"[^"]*")?)\)(?:\s*\{width=(\d{1,3}(?:\.\d+)?)%\})?/g, (_match, alt: string, target: string, widthText?: string) => {
    const href = target.replace(/\s+"[^"]*"$/, '');
    const imageSource = imageSources.get(href);
    return imageSource ? '<img src="' + imageSource + '" alt="' + alt + '" loading="lazy"' + imageWidthClass(widthText) + '>' : '<span>' + alt + '</span>';
  });
  value = value.replace(/\[([^\]]+)\]\(([^ )]+)(?:\s+"[^"]*")?\)/g, (_match, label: string, href: string) => {
    const safeHref = href.replace(/&amp;/g, '&amp;').replace(/"/g, '&quot;');
    const external = /^https?:\/\//i.test(href);
    return '<a href="' + safeHref + '"' + (external ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + label + '</a>';
  });
  htmlImages.forEach((html, index) => {
    value = value.replace('__LUMASCOPE_HTML_IMAGE_' + index + '__', html);
  });
  return value;
};

const splitTableRow = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());

const isTableSeparator = (line: string | undefined): boolean =>
  !!line && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

const renderMarkdown = (markdown: string, imageSources: ReadonlyMap<string, string>, searchQuery = ''): string => {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const output: string[] = [];
  let index = 0;

  const isBlockStart = (line: string, next?: string): boolean =>
    /^\s*```/.test(line) || /^#{1,6}\s/.test(line) || /^\s*([-*_])\1\1+\s*$/.test(line) ||
    /^\s*>/.test(line) || /^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line) ||
    (line.trim().startsWith('|') && isTableSeparator(next));

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }

    if (line.trim().startsWith('```')) {
      const language = line.trim().slice(3).trim();
      index++;
      const code: string[] = [];
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push('<span id="help-search-line-' + (index + 1) + '" class="help-search-line-anchor"></span>' + escapeHtml(lines[index]));
        index++;
      }
      if (index < lines.length) index++;
      output.push('<pre><code' + (language ? ' class="language-' + escapeHtml(language) + '"' : '') + '>' + code.join('\n') + '</code></pre>');
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      const lineNumber = index + 1;
      const level = heading[1].length;
      output.push('<span id="help-search-line-' + lineNumber + '" class="help-search-line-anchor"></span><h' + level + '>' + renderInline(heading[2], imageSources, searchQuery) + '</h' + level + '>');
      index++;
      continue;
    }

    if (/^\s*([-*_])\1\1+\s*$/.test(line)) {
      output.push('<span id="help-search-line-' + (index + 1) + '" class="help-search-line-anchor"></span><hr>');
      index++;
      continue;
    }

    if (line.trim().startsWith('|') && isTableSeparator(lines[index + 1])) {
      const tableLineNumber = index + 1;
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        const cells = splitTableRow(lines[index]);
        rows.push('<tr id="help-search-line-' + (index + 1) + '">' + headers.map((_header, cellIndex) => '<td>' + renderInline(cells[cellIndex] ?? '', imageSources, searchQuery) + '</td>').join('') + '</tr>');
        index++;
      }
      output.push('<span id="help-search-line-' + tableLineNumber + '" class="help-search-line-anchor"></span><div class="markdown-table-wrap"><table><thead><tr>' + headers.map(cell => '<th>' + renderInline(cell, imageSources, searchQuery) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>');
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push('<li id="help-search-line-' + (index + 1) + '">' + renderInline(lines[index].replace(/^\s*[-*+]\s+/, ''), imageSources, searchQuery) + '</li>');
        index++;
      }
      output.push('<ul>' + items.join('') + '</ul>');
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const listLineNumber = index + 1;
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push('<li id="help-search-line-' + (index + 1) + '">' + renderInline(lines[index].replace(/^\s*\d+\.\s+/, ''), imageSources, searchQuery) + '</li>');
        index++;
      }
      output.push('<ol>' + items.join('') + '</ol>');
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push('<span id="help-search-line-' + (index + 1) + '" class="help-search-line-anchor"></span>' + renderInline(lines[index].replace(/^\s*>\s?/, ''), imageSources, searchQuery));
        index++;
      }
      output.push('<blockquote>' + quote.join('<br>') + '</blockquote>');
      continue;
    }

    const paragraphLineNumber = index + 1;
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index], lines[index + 1])) {
      paragraph.push(lines[index++].trim());
    }
    if (paragraph.length === 0) {
      paragraph.push(line.trim());
      index++;
    }
    const renderedParagraphLines = paragraph.map(line => renderInline(line, imageSources, searchQuery));
    const paragraphHtml = renderedParagraphLines.map((renderedLine, lineIndex) =>
      '<span id="help-search-line-' + (paragraphLineNumber + lineIndex) + '" class="help-search-line-anchor"></span>' + renderedLine
    ).join('<br>');
    if (renderedParagraphLines.every(renderedLine => /^\s*(?:<img\b[^>]*>\s*)+$/i.test(renderedLine))) {
      output.push('<div class="markdown-image-row">' + paragraphHtml + '</div>');
    } else {
      output.push('<p>' + paragraphHtml + '</p>');
    }
  }

  return output.join('\n');
};

@Component({
  selector: 'app-markdown-viewer',
  imports: [SliderComponent],
  templateUrl: './markdown-viewer.component.html',
  styleUrl: './markdown-viewer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MarkdownViewerComponent {
  readonly initialDocument = input<string | null>(null);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly fileSystem = inject(FileSystem);
  private readonly processManager = inject(ProcessManager);

  protected readonly currentFile = signal('README.md');
  protected readonly markdown = signal('');
  protected readonly imageSources = signal<ReadonlyMap<string, string>>(new Map());
  protected readonly loading = signal(true);
  protected readonly fontSize = signal(12);
  protected readonly error = signal<string | null>(null);
  protected readonly highlightQuery = signal('');
  protected readonly renderedHtml = computed(() => renderMarkdown(this.markdown(), this.imageSources(), this.highlightQuery()));
  protected readonly documentTitle = computed(() =>
    this.currentFile() === 'README.md'
      ? 'LumaScope documentation'
      : this.currentFile().replace(/\.md$/i, '').replace(/-/g, ' ')
  );
  protected readonly documentationPath = computed(() =>
    this.currentFile() === 'README.md' ? 'README.md' : 'docs/' + this.currentFile()
  );
  protected readonly openFileError = signal('');
  protected readonly sitemapOpen = signal(false);
  protected readonly sitemapEntries = computed(() => helpDocuments.map(fileName => ({
    fileName,
    title: fileName === 'README.md' ? 'Overview' : fileName.replace(/\.md$/i, '').replace(/-/g, ' ')
  })));
  protected readonly searchQuery = signal('');
  protected readonly searchResults = signal<HelpSearchGroup[]>([]);
  protected readonly searchResultCount = computed(() => this.searchResults().reduce((count, group) => count + group.results.length, 0));
  protected readonly flatSearchResults = computed(() => this.searchResults().flatMap(group => group.results));
  protected readonly activeSearchResultIndex = signal(-1);
  protected readonly searchPaneSize = signal(42);
  private resizePointerId: number | null = null;
  protected readonly searchBusy = signal(false);
  protected readonly searchError = signal('');
  private documentLoadRequest = 0;
  private searchRequest = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.loadDocument('README.md');
    effect(() => {
      const fileName = this.initialDocument();
      if (fileName && fileName !== untracked(() => this.currentFile())) void this.loadDocument(fileName);
    });
    void this.loadSavedFontSize();
  }

  private readonly loadSavedFontSize = async (): Promise<void> => {
    try {
      const settings = await this.processManager.getAppSettings();
      const helpSettings = settings['help'];
      if (!helpSettings || typeof helpSettings !== 'object' || Array.isArray(helpSettings)) return;
      const savedSize = (helpSettings as Record<string, unknown>)['textSize'];
      if (typeof savedSize === 'number' && Number.isFinite(savedSize)) {
        this.fontSize.set(Math.min(20, Math.max(10, Math.round(savedSize))));
      }
    } catch (error) {
      console.warn('[Help] Could not load text size setting:', error);
    }
  };

  protected readonly loadDocument = async (fileName: string, targetLine?: number): Promise<void> => {
    if (!isDocumentationFile(fileName)) return;
    const request = ++this.documentLoadRequest;
    this.loading.set(true);
    this.error.set(null);
    this.openFileError.set('');
    try {
      const response = await this.fileSystem.readDocumentationFile(fileName);
      if (request !== this.documentLoadRequest) return;
      if (response.success) {
        const imageSources = new Map<string, string>();
        const imagePattern = /!\[[^\]]*\]\(((?:[^()]|\([^()]*\))+(?:\s+"[^"]*")?)\)(?:\s*\{width=\d{1,3}(?:\.\d+)?%\})?|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
        const imagePaths = new Set<string>();
        for (const match of response.data.matchAll(imagePattern)) {
          const href = match[1] ?? match[2];
          const allowedPath = fileName === 'README.md'
            ? /^docs\/images\/([a-zA-Z0-9_().-]+\.(?:png|jpe?g|webp|gif))$/i.exec(href)
            : /^images\/([a-zA-Z0-9_().-]+\.(?:png|jpe?g|webp|gif))$/i.exec(href);
          if (allowedPath) imagePaths.add(href);
        }
        await Promise.all([...imagePaths].map(async href => {
          const imageName = href.split('/').pop()!;
          const image = await this.fileSystem.readDocumentationImage(imageName);
          if (image.success) imageSources.set(href, image.data);
        }));
        if (request !== this.documentLoadRequest) return;
        this.currentFile.set(fileName);
        this.imageSources.set(imageSources);
        this.markdown.set(response.data);
      } else {
        this.error.set(response.errorMessage);
      }
    } catch (error) {
      if (request === this.documentLoadRequest) this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === this.documentLoadRequest) {
        this.loading.set(false);
        if (targetLine && targetLine > 0 && request === this.documentLoadRequest) {
          // The article only exists after loading becomes false and Angular renders
          // the new Markdown. Start line navigation after that view update.
          const result = { fileName, lineNumber: targetLine, snippet: '' };
          this.document.defaultView?.requestAnimationFrame(() =>
            this.document.defaultView?.requestAnimationFrame(() => this.scrollToSearchResult(result, request))
          );
        }
      }
    }
  };


  protected readonly beginSearchPaneResize = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    this.resizePointerId = event.pointerId;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  protected readonly resizeSearchPane = (event: PointerEvent): void => {
    if (this.resizePointerId !== event.pointerId) return;
    const container = (event.currentTarget as HTMLElement).parentElement;
    const searchPane = container?.querySelector<HTMLElement>('.markdown-help-search');
    const article = container?.querySelector<HTMLElement>('.markdown-body');
    const resizer = event.currentTarget as HTMLElement;
    if (!searchPane || !article) return;
    const availableHeight = article.getBoundingClientRect().bottom
      - searchPane.getBoundingClientRect().top - resizer.getBoundingClientRect().height;
    if (availableHeight <= 0) return;
    const requestedHeight = event.clientY - searchPane.getBoundingClientRect().top
      - resizer.getBoundingClientRect().height / 2;
    const percentage = requestedHeight / availableHeight * 100;
    this.searchPaneSize.set(Math.min(70, Math.max(20, Math.round(percentage))));
  };

  protected readonly endSearchPaneResize = (event: PointerEvent): void => {
    if (this.resizePointerId !== event.pointerId) return;
    const handle = event.currentTarget as HTMLElement;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    this.resizePointerId = null;
  };

  protected readonly onSearchPaneResizeKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? -2 : 2;
      this.searchPaneSize.update(value => Math.min(70, Math.max(20, value + delta)));
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.searchPaneSize.set(20);
    } else if (event.key === 'End') {
      event.preventDefault();
      this.searchPaneSize.set(70);
    }
  };

  protected readonly onSearchKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === 'F3') {
      if (!this.flatSearchResults().length || this.searchBusy()) return;
      event.preventDefault();
      event.stopPropagation();
      this.navigateSearchResult(event.shiftKey ? -1 : 1);
    }
  };

  @HostListener('document:keydown', ['$event'])
  protected onGlobalSearchKeydown(event: KeyboardEvent): void {
    // F3 navigation must remain available after focus moves from the search field
    // to a result row or into the Markdown article.
    if (event.key !== 'F3' || !this.flatSearchResults().length || this.searchBusy()) return;
    event.preventDefault();
    event.stopPropagation();
    this.navigateSearchResult(event.shiftKey ? -1 : 1);
  }

  protected readonly onSearchPanelKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'F3' || !this.flatSearchResults().length || this.searchBusy()) return;
    event.preventDefault();
    event.stopPropagation();
    this.navigateSearchResult(event.shiftKey ? -1 : 1);
  };

  protected readonly onSearchInput = (query: string): void => {
    this.searchQuery.set(query);
    this.highlightQuery.set(query.trim().length >= 2 ? query.trim() : '');
    this.activeSearchResultIndex.set(-1);
    this.searchResults.set([]);
    this.searchError.set('');
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    const request = ++this.searchRequest;
    const normalized = query.trim();
    if (normalized.length < 2) {
      this.searchBusy.set(false);
      return;
    }
    this.searchBusy.set(true);
    this.searchTimer = setTimeout(() => { void this.searchDocumentation(normalized, request); }, 250);
  };

  private readonly searchDocumentation = async (query: string, request: number): Promise<void> => {
    const groups: HelpSearchGroup[] = [];
    const needle = query.toLocaleLowerCase();
    try {
      const documents = await Promise.all(helpDocuments.map(async fileName => {
        const response = await this.fileSystem.readDocumentationFile(fileName);
        return response.success ? { fileName, content: response.data } : null;
      }));
      if (request !== this.searchRequest) return;
      for (const document of documents) {
        if (!document) continue;
        const lines = document.content.split(/\r?\n/);
        const documentResults: HelpSearchResult[] = [];
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index].trim();
          if (!line || !line.toLocaleLowerCase().includes(needle)) continue;
          const snippet = line.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s*/, '');
          documentResults.push({
            fileName: document.fileName,
            lineNumber: index + 1,
            snippet: snippet.length > 220 ? snippet.slice(0, 217) + '…' : snippet
          });
        }
        if (documentResults.length) groups.push({
          fileName: document.fileName,
          title: document.fileName === 'README.md' ? 'Overview' : document.fileName.replace(/\.md$/i, '').replace(/-/g, ' '),
          results: documentResults
        });
      }
      if (request === this.searchRequest) this.searchResults.set(groups);
    } catch (error) {
      if (request === this.searchRequest) this.searchError.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === this.searchRequest) this.searchBusy.set(false);
    }
  };

  private readonly scrollToSearchResult = (result: HelpSearchResult, expectedRequest = this.documentLoadRequest): void => {
    const view = this.document.defaultView;
    if (!view) return;
    let attempts = 0;
    const findAndScroll = (): void => {
      if (expectedRequest !== this.documentLoadRequest || this.currentFile() !== result.fileName) {
        console.debug('[HelpSearchNav] scroll aborted', {
          fileName: result.fileName,
          lineNumber: result.lineNumber,
          expectedRequest,
          currentRequest: this.documentLoadRequest,
          currentFile: this.currentFile()
        });
        return;
      }
      // Resolve the article inside this single Help viewer instance.
      // ElementRef.nativeElement is typed as any by Angular's DI token, so
      // narrow it before using the DOM query APIs.
      const hostElement = this.host.nativeElement as HTMLElement;
      const article = hostElement.querySelector('.markdown-body') as HTMLElement | null;
      const target = article?.querySelector('#help-search-line-' + result.lineNumber) as HTMLElement | null;
      if (!article || !target) {
        attempts++;
        if (attempts === 1 || attempts >= 12) {
          console.warn('[HelpSearchNav] target not found', {
            fileName: result.fileName,
            lineNumber: result.lineNumber,
            attempt: attempts,
            hostConnected: hostElement.isConnected,
            articleFound: !!article,
            currentFile: this.currentFile(),
            loading: this.loading(),
            renderedHtmlLength: this.renderedHtml().length
          });
        }
        if (attempts < 12) view.requestAnimationFrame(findAndScroll);
        return;
      }
      // Highlight the containing block. Heading and table-start anchors are
      // siblings of their rendered block, while paragraph/code anchors are inside it.
      const block = target.matches('li, tr')
        ? target
        : target.closest('p, li, tr, blockquote, pre, h1, h2, h3, h4, h5, h6, .markdown-image-row')
          ?? target.nextElementSibling as HTMLElement | null;
      article.querySelectorAll('.active-search-line').forEach((element: Element) => element.classList.remove('active-search-line'));
      block?.classList.add('active-search-line');

      // Let the browser calculate the scroll delta for the exact source-line
      // anchor. This also handles anchors nested in paragraphs, code blocks,
      // lists and tables without relying on offset-parent geometry.
      const before = {
        scrollTop: article.scrollTop,
        scrollHeight: article.scrollHeight,
        clientHeight: article.clientHeight,
        targetTop: target.getBoundingClientRect().top,
        articleTop: article.getBoundingClientRect().top,
        targetTag: target.tagName,
        targetClass: target.className,
        blockTag: block?.tagName ?? null,
        blockClass: block?.className ?? null
      };
      target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
      console.debug('[HelpSearchNav] scrolled to result', {
        fileName: result.fileName,
        lineNumber: result.lineNumber,
        attempt: attempts,
        ...before,
        scrollTopAfter: article.scrollTop,
        targetTopAfter: target.getBoundingClientRect().top,
        articleTopAfter: article.getBoundingClientRect().top
      });
    };
    view.requestAnimationFrame(() => view.requestAnimationFrame(findAndScroll));
  };

  protected readonly onSearchResultKeydown = (event: KeyboardEvent, result: HelpSearchResult): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.openSearchResult(result);
  };

  protected readonly openSearchResult = (result: HelpSearchResult): void => {
    const index = this.flatSearchResults().findIndex(item => item.fileName === result.fileName && item.lineNumber === result.lineNumber);
    this.activeSearchResultIndex.set(index);
    if (this.currentFile() === result.fileName && !this.loading()) this.scrollToSearchResult(result);
    else void this.loadDocument(result.fileName, result.lineNumber);
  };

  protected readonly navigateSearchResult = (direction: -1 | 1): void => {
    const results = this.flatSearchResults();
    if (!results.length) return;
    const currentIndex = this.activeSearchResultIndex();
    const nextIndex = currentIndex < 0
      ? (direction === 1 ? 0 : results.length - 1)
      : (currentIndex + direction + results.length) % results.length;
    this.activeSearchResultIndex.set(nextIndex);
    const result = results[nextIndex];
    const samePage = this.currentFile() === result.fileName;
    console.debug('[HelpSearchNav] navigate', {
      direction,
      resultCount: results.length,
      previousIndex: currentIndex,
      nextIndex,
      fileName: result.fileName,
      lineNumber: result.lineNumber,
      currentFile: this.currentFile(),
      loading: this.loading(),
      samePage,
      documentLoadRequest: this.documentLoadRequest
    });
    if (samePage && !this.loading()) this.scrollToSearchResult(result);
    else void this.loadDocument(result.fileName, result.lineNumber);
  };

  protected readonly onFontSizeChange = (value: number): void => {
    if (Number.isFinite(value)) this.fontSize.set(Math.min(20, Math.max(10, value)));
  };

  protected readonly saveFontSize = async (): Promise<void> => {
    try {
      await this.processManager.setAppSettingsSection('help', { textSize: this.fontSize() });
    } catch (error) {
      console.warn('[Help] Could not save text size setting:', error);
    }
  };

  protected readonly openCurrentDocument = async (): Promise<void> => {
    this.openFileError.set('');
    try {
      const result = await this.fileSystem.openDocumentationFile(this.currentFile());
      if (result) this.openFileError.set(result);
    } catch (error) {
      this.openFileError.set(error instanceof Error ? error.message : String(error));
    }
  };

  protected readonly toggleSitemap = (): void => {
    this.sitemapOpen.update(open => !open);
  };

  protected readonly openSitemapEntry = (fileName: string): void => {
    this.sitemapOpen.set(false);
    this.searchQuery.set('');
    this.searchResults.set([]);
    void this.loadDocument(fileName);
  };

  protected readonly showReadme = (): void => {
    // Switch the visible document immediately so a pending initial-document
    // input cannot keep the old page selected while the README is loading.
    this.currentFile.set('README.md');
    void this.loadDocument('README.md');
  };

  protected readonly onDocumentClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a');
    const href = anchor?.getAttribute('href');
    if (!anchor || !href || /^(?:https?:|mailto:|#)/i.test(href)) return;

    // Never allow an unsupported relative Markdown link to navigate the Electron
    // window away from the application. Only allowlisted documents are loaded here.
    event.preventDefault();

    const base = this.currentFile() === 'README.md' ? [] : [ 'docs' ];
    const parts = [...base];
    for (const part of href.split(/[?#]/, 1)[0].split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(decodeURIComponent(part));
    }
    const normalized = parts.join('/');
    const fileName = normalized === 'README.md' ? 'README.md' : normalized.startsWith('docs/') ? normalized.slice(5) : '';
    if (!isDocumentationFile(fileName)) return;
    void this.loadDocument(fileName);
  };
}
