import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { CapturePanelComponent } from '../../components/capture-panel/capture-panel.component';

@Component({
  selector: 'app-capture-preview-window',
  standalone: true,
  imports: [CapturePanelComponent],
  template: `
    <main class="capture-window">
      <header class="capture-titlebar">
        <div class="capture-title"><span aria-hidden="true">◉</span><strong>HDR Capture</strong></div>
        <button type="button" class="settings-toggle" [class.active]="settingsOpen()"
                (click)="toggleSettings()" [attr.aria-expanded]="settingsOpen()"
                title="Show or hide capture settings" aria-label="Capture settings">
          ⚙ <span>Settings</span>
        </button>
      </header>
      <app-capture-panel [settingsVisible]="settingsOpen()" />
    </main>
  `,
  styles: [`
    :host{display:block;width:100%;height:100%;min-width:0;min-height:0;color:var(--text-color,#eee);font:13px/1.4 inherit}
    .capture-window{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;background:var(--surface-1,#202124)}
    .capture-titlebar{height:38px;min-height:38px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 10px;background:var(--surface-2,#292a2d);border-bottom:1px solid rgb(128 128 128 / 35%);box-sizing:border-box}
    .capture-title{display:flex;align-items:center;gap:9px;font-size:13px}.capture-title>span{font-size:17px;color:#8ab4f8}
    .settings-toggle{height:28px;padding:4px 9px;white-space:nowrap;color:inherit;background:rgb(128 128 128 / 12%);border:1px solid rgb(128 128 128 / 40%);border-radius:4px;font:inherit;cursor:pointer}
    .settings-toggle:hover,.settings-toggle.active{background:rgb(100 150 220 / 20%);border-color:#8ab4f8}
    .settings-toggle span{margin-left:3px}
    app-capture-panel{display:block;flex:1 1 auto;min-height:0;overflow:auto}
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CapturePreviewWindow {
  protected readonly settingsOpen = signal(true);
  protected readonly toggleSettings = (): void => this.settingsOpen.update(open => !open);
}
