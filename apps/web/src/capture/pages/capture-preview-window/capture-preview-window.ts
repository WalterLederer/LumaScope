import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ThemeService } from '../../../system/services/theme/theme.service';
import { CapturePanelComponent } from '../../components/capture-panel/capture-panel.component';

@Component({
  selector: 'app-capture-preview-window',
  standalone: true,
  imports: [CapturePanelComponent],
  template: `
    <main class="capture-window" [class.light-theme]="themeService.current() === 'light'">
      <app-capture-panel />
    </main>
  `,
  styles: [`
    :host{display:block;width:100%;height:100%;min-width:0;min-height:0;color:var(--color-content-default-high,#eee);font:13px/1.4 inherit}
    .capture-window{color-scheme:dark;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;background:var(--color-surface-default-low,#202124)}
    .capture-window.light-theme{color-scheme:light;color:#202124;background:#f7f7f8}
    app-capture-panel{display:block;flex:1 1 auto;min-height:0;overflow:auto}
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CapturePreviewWindow {
  protected readonly themeService = inject(ThemeService);
}
