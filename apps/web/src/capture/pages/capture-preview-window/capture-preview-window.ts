import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, inject, viewChild } from '@angular/core';
import { CapturePreview, Desktop } from 'internal-api';

@Component({
  selector: 'app-capture-preview-window',
  standalone: true,
  template: '<main class="preview"><canvas #canvas></canvas><p>{{ status }}</p></main>',
  styles: [':host{display:block;width:100%;height:100%;background:#080808;color:#ddd}.preview{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden}.preview canvas{display:block;width:100%;height:calc(100% - 28px);object-fit:contain}.preview p{height:20px;margin:4px;font:12px sans-serif}'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CapturePreviewWindow implements OnInit, OnDestroy {
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly desktop = (window as unknown as { desktop?: Desktop }).desktop;
  private unsubscribe: (() => void) | null = null;
  private device: any = null;
  private texture: any = null;
  private context: any = null;
  status = 'Waiting for an HDR capture frame…';

  ngOnInit(): void {
    if (!this.desktop) { this.status = 'Desktop capture is unavailable.'; return; }
    this.unsubscribe = this.desktop.CapturePreviewWindow.onFrameChanged(frame => void this.render(frame));
    void this.desktop.CapturePreviewWindow.getFrame().then(frame => {
      if (frame) void this.render(frame);
      else this.status = 'No cached frame yet. Create a preview in the Capture tab.';
    }).catch(error => this.status = error instanceof Error ? error.message : String(error));
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
    this.dispose();
  }

  private dispose(): void {
    try { this.context?.unconfigure(); } catch { /* already unconfigured */ }
    this.texture?.destroy();
    this.device?.destroy();
    this.texture = this.device = this.context = null;
  }

  private async render(frame: CapturePreview): Promise<void> {
    this.dispose();
    const gpu = (navigator as Navigator & { gpu?: any }).gpu;
    if (!gpu) { this.status = 'WebGPU is unavailable; HDR preview cannot be displayed.'; return; }
    const canvas = this.canvas().nativeElement;
    canvas.width = frame.width;
    canvas.height = frame.height;
    const adapter = await gpu.requestAdapter();
    if (!adapter) { this.status = 'No WebGPU adapter is available.'; return; }
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu') as any;
    if (!context) { device.destroy(); this.status = 'Could not create a WebGPU canvas.'; return; }
    context.configure({ device, format: 'rgba16float', colorSpace: 'srgb', alphaMode: 'opaque', toneMapping: { mode: 'extended' } });
    const texture = device.createTexture({ size: { width: frame.width, height: frame.height }, format: 'rgba16float', usage: 4 | 2 });
    device.queue.writeTexture({ texture }, frame.pixels, { bytesPerRow: frame.width * 8, rowsPerImage: frame.height }, { width: frame.width, height: frame.height, depthOrArrayLayers: 1 });
    const shader = device.createShaderModule({ code: `
      @group(0) @binding(0) var sourceTexture: texture_2d<f32>;
      struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
      @vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOutput {
        var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));
        var output: VertexOutput; let p = positions[index]; output.position = vec4<f32>(p,0.0,1.0);
        output.uv = vec2<f32>((p.x+1.0)*0.5,(1.0-p.y)*0.5); return output;
      }
      fn linearToExtendedSrgb(value:f32)->f32 { if(value<=0.0031308){return value*12.92;} return 1.055*pow(value,1.0/2.4)-0.055; }
      @fragment fn fs(input:VertexOutput)->@location(0) vec4<f32> {
        let dims=vec2<i32>(textureDimensions(sourceTexture));
        let coords=vec2<i32>(clamp(input.uv*vec2<f32>(dims),vec2<f32>(0.0),vec2<f32>(dims-vec2<i32>(1,1))));
        let c=textureLoad(sourceTexture,coords,0).rgb*0.4;
        return vec4<f32>(linearToExtendedSrgb(c.r),linearToExtendedSrgb(c.g),linearToExtendedSrgb(c.b),1.0);
      }` });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vs' }, fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] }, primitive: { topology: 'triangle-list' } });
    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end(); device.queue.submit([encoder.finish()]);
    this.device = device; this.texture = texture; this.context = context;
    this.status = `HDR FP16/scRGB · ${frame.width} × ${frame.height} · brightness 0.4`;
  }
}
