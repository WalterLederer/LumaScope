import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FileSystem } from '../../../ipc/file-system';
import { ProcessManager } from '../../../ipc/process-manager';

const isDocumentationFile = (fileName: string): boolean => /^[a-zA-Z0-9_-]+\.md$/i.test(fileName);

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const renderInline = (source: string, imageSources: ReadonlyMap<string, string>): string => {
  const htmlImages: string[] = [];
  const withImagePlaceholders = source.replace(/<img\b([^>]*)>/gi, (_match, attributes: string) => {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] ?? '';
    const widthText = /\bwidth\s*=\s*["']?(\d{1,3}(?:\.\d+)?)%?["']?/i.exec(attributes)?.[1];
    const imageSource = src ? imageSources.get(src) : undefined;
    const width = widthText ? Number(widthText) : NaN;
    const widthStyle = Number.isFinite(width) && width > 0 && width <= 100
      ? ' style="width: ' + width + '%; max-width: 100%; height: auto;"'
      : ' style="max-width: 100%; height: auto;"';
    const rendered = imageSource
      ? '<img src="' + imageSource + '" alt="' + escapeHtml(alt) + '" loading="lazy"' + widthStyle + '>'
      : '<span>' + escapeHtml(alt) + '</span>';
    const token = '__LUMASCOPE_HTML_IMAGE_' + htmlImages.length + '__';
    htmlImages.push(rendered);
    return token;
  });
  let value = escapeHtml(withImagePlaceholders);
  value = value.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  value = value.replace(/!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))+(?:\s+"[^"]*")?)\)(?:\s*\{width=(\d{1,3}(?:\.\d+)?)%\})?/g, (_match, alt: string, target: string, widthText?: string) => {
    const href = target.replace(/\s+"[^"]*"$/, '');
    const imageSource = imageSources.get(href);
    const width = widthText ? Number(widthText) : NaN;
    const widthStyle = Number.isFinite(width) && width > 0 && width <= 100
      ? ' style="width: ' + width + '%; max-width: 100%; height: auto;"'
      : ' style="max-width: 100%; height: auto;"';
    return imageSource ? '<img src="' + imageSource + '" alt="' + alt + '" loading="lazy"' + widthStyle + '>' : '<span>' + alt + '</span>';
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

const renderMarkdown = (markdown: string, imageSources: ReadonlyMap<string, string>): string => {
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
      while (index < lines.length && !lines[index].trim().startsWith('```')) code.push(lines[index++]);
      if (index < lines.length) index++;
      output.push('<pre><code' + (language ? ' class="language-' + escapeHtml(language) + '"' : '') + '>' + escapeHtml(code.join('\n')) + '</code></pre>');
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      const level = heading[1].length;
      output.push('<h' + level + '>' + renderInline(heading[2], imageSources) + '</h' + level + '>');
      index++;
      continue;
    }

    if (/^\s*([-*_])\1\1+\s*$/.test(line)) {
      output.push('<hr>');
      index++;
      continue;
    }

    if (line.trim().startsWith('|') && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        const cells = splitTableRow(lines[index]);
        rows.push('<tr>' + headers.map((_header, cellIndex) => '<td>' + renderInline(cells[cellIndex] ?? '', imageSources) + '</td>').join('') + '</tr>');
        index++;
      }
      output.push('<div class="markdown-table-wrap"><table><thead><tr>' + headers.map(cell => '<th>' + renderInline(cell, imageSources) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>');
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push('<li>' + renderInline(lines[index].replace(/^\s*[-*+]\s+/, ''), imageSources) + '</li>');
        index++;
      }
      output.push('<ul>' + items.join('') + '</ul>');
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push('<li>' + renderInline(lines[index].replace(/^\s*\d+\.\s+/, ''), imageSources) + '</li>');
        index++;
      }
      output.push('<ol>' + items.join('') + '</ol>');
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(renderInline(lines[index++].replace(/^\s*>\s?/, ''), imageSources));
      output.push('<blockquote>' + quote.join('<br>') + '</blockquote>');
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index], lines[index + 1])) {
      paragraph.push(lines[index++].trim());
    }
    if (paragraph.length === 0) {
      paragraph.push(line.trim());
      index++;
    }
    output.push('<p>' + paragraph.map(line => renderInline(line, imageSources)).join('<br>') + '</p>');
  }

  return output.join('\n');
};

@Component({
  selector: 'app-markdown-viewer',
  templateUrl: './markdown-viewer.component.html',
  styleUrl: './markdown-viewer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MarkdownViewerComponent {
  private readonly fileSystem = inject(FileSystem);
  private readonly processManager = inject(ProcessManager);

  protected readonly currentFile = signal('README.md');
  protected readonly markdown = signal('');
  protected readonly imageSources = signal<ReadonlyMap<string, string>>(new Map());
  protected readonly loading = signal(true);
  protected readonly fontSize = signal(12);
  protected readonly error = signal<string | null>(null);
  protected readonly renderedHtml = computed(() => renderMarkdown(this.markdown(), this.imageSources()));
  protected readonly documentTitle = computed(() =>
    this.currentFile() === 'README.md'
      ? 'LumaScope documentation'
      : this.currentFile().replace(/\.md$/i, '').replace(/-/g, ' ')
  );

  constructor() {
    void this.loadDocument('README.md');
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

  protected readonly loadDocument = async (fileName: string): Promise<void> => {
    if (!isDocumentationFile(fileName)) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const response = await this.fileSystem.readDocumentationFile(fileName);
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
        this.currentFile.set(fileName);
        this.imageSources.set(imageSources);
        this.markdown.set(response.data);
      } else {
        this.error.set(response.errorMessage);
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
    }
  };

  protected readonly onFontSizeChange = (event: Event): void => {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.fontSize.set(Math.min(20, Math.max(10, value)));
  };

  protected readonly saveFontSize = async (): Promise<void> => {
    try {
      await this.processManager.setAppSettingsSection('help', { textSize: this.fontSize() });
    } catch (error) {
      console.warn('[Help] Could not save text size setting:', error);
    }
  };

  protected readonly showReadme = (): void => {
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
