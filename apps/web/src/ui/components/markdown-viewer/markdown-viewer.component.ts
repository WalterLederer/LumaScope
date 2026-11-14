import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FileSystem } from '../../../ipc/file-system';

const documentationFiles = new Set([
  'README.md',
  'features.md',
  'image-formats.md',
  'map-formats.md',
  'shortcuts.md',
  'external-programs.md',
  'windows-api.md'
]);

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const renderInline = (source: string): string => {
  let value = escapeHtml(source);
  value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  value = value.replace(/\[([^\]]+)\]\(([^ )]+)(?:\s+"[^"]*")?\)/g, (_match, label: string, href: string) => {
    const safeHref = href.replace(/&amp;/g, '&amp;').replace(/"/g, '&quot;');
    const external = /^https?:\/\//i.test(href);
    return '<a href="' + safeHref + '"' + (external ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + label + '</a>';
  });
  return value;
};

const splitTableRow = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());

const isTableSeparator = (line: string | undefined): boolean =>
  !!line && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

const renderMarkdown = (markdown: string): string => {
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
      output.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
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
        rows.push('<tr>' + headers.map((_header, cellIndex) => '<td>' + renderInline(cells[cellIndex] ?? '') + '</td>').join('') + '</tr>');
        index++;
      }
      output.push('<div class="markdown-table-wrap"><table><thead><tr>' + headers.map(cell => '<th>' + renderInline(cell) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>');
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push('<li>' + renderInline(lines[index].replace(/^\s*[-*+]\s+/, '')) + '</li>');
        index++;
      }
      output.push('<ul>' + items.join('') + '</ul>');
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push('<li>' + renderInline(lines[index].replace(/^\s*\d+\.\s+/, '')) + '</li>');
        index++;
      }
      output.push('<ol>' + items.join('') + '</ol>');
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(renderInline(lines[index++].replace(/^\s*>\s?/, '')));
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
    output.push('<p>' + paragraph.map(renderInline).join('<br>') + '</p>');
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

  protected readonly currentFile = signal('README.md');
  protected readonly markdown = signal('');
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly renderedHtml = computed(() => renderMarkdown(this.markdown()));
  protected readonly documentTitle = computed(() =>
    this.currentFile() === 'README.md'
      ? 'LumaScope documentation'
      : this.currentFile().replace(/\.md$/i, '').replace(/-/g, ' ')
  );

  constructor() {
    void this.loadDocument('README.md');
  }

  protected readonly loadDocument = async (fileName: string): Promise<void> => {
    if (!documentationFiles.has(fileName)) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const response = await this.fileSystem.readDocumentationFile(fileName);
      if (response.success) {
        this.currentFile.set(fileName);
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

  protected readonly showReadme = (): void => {
    void this.loadDocument('README.md');
  };

  protected readonly onDocumentClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a');
    const href = anchor?.getAttribute('href');
    if (!anchor || !href || /^(?:https?:|mailto:|#)/i.test(href)) return;

    const base = this.currentFile() === 'README.md' ? [] : [ 'docs' ];
    const parts = [...base];
    for (const part of href.split(/[?#]/, 1)[0].split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(decodeURIComponent(part));
    }
    const normalized = parts.join('/');
    const fileName = normalized === 'README.md' ? 'README.md' : normalized.startsWith('docs/') ? normalized.slice(5) : '';
    if (!documentationFiles.has(fileName)) return;
    event.preventDefault();
    void this.loadDocument(fileName);
  };
}
