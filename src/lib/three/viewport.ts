import { AmbientLight, DirectionalLight, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { createSafeError, type SafeError } from "../errors";
import { disposeObject3D, disposeRenderer } from "./disposal";

export interface ViewportOptions {
  container: HTMLElement;
  /** Hard cap on device pixel ratio to protect performance on high-DPI displays. Defaults to 2. */
  maxPixelRatio?: number;
  onContextLost?: (error: SafeError) => void;
  /**
   * Keep the drawing buffer after rendering instead of letting the browser
   * clear it post-composite. Costs a little memory/perf; only needed by
   * tools that call `canvas.toBlob()`/`toDataURL()` for screenshot export.
   * Defaults to false.
   */
  preserveDrawingBuffer?: boolean;
}

/**
 * Reusable renderer/scene/camera/lighting/resize/disposal scaffolding for
 * any future 3D tool page. Renders on demand (`requestRender`) rather than
 * running a continuous loop, since most tool viewports are static until a
 * model loads or the user orbits the camera.
 */
export class ToolViewport {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: WebGLRenderer;
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private onContextLost?: (error: SafeError) => void;

  private animationHandle: number | null = null;
  private needsRender = true;
  private visible = true;
  private disposed = false;

  constructor(options: ViewportOptions) {
    this.container = options.container;
    this.onContextLost = options.onContextLost;

    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "3D preview");

    try {
      this.renderer = new WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      });
    } catch {
      throw createSafeError("WEBGL_UNAVAILABLE");
    }

    const maxPixelRatio = options.maxPixelRatio ?? 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));

    const rect = this.container.getBoundingClientRect();
    this.camera = new PerspectiveCamera(50, rect.width / Math.max(rect.height, 1), 0.1, 1000);
    this.camera.position.set(2.2, 1.8, 2.6);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new AmbientLight(0xffffff, 0.6));
    const key = new DirectionalLight(0xffffff, 0.9);
    key.position.set(3, 4, 2);
    this.scene.add(key);

    this.container.appendChild(this.canvas);
    this.resize(rect.width, rect.height);

    this.canvas.addEventListener("webglcontextlost", this.handleContextLost, false);

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.resize(entry.contentRect.width, entry.contentRect.height);
    });
    this.resizeObserver.observe(this.container);
  }

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.stopLoop();
    this.onContextLost?.(createSafeError("WEBGL_CONTEXT_LOST"));
  };

  private resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.requestRender();
  }

  /** Schedules a single frame. Safe to call repeatedly — extra calls before the frame runs are coalesced. */
  requestRender(): void {
    this.needsRender = true;
    if (this.animationHandle === null && this.visible && !this.disposed) {
      this.animationHandle = requestAnimationFrame(this.renderFrame);
    }
  }

  private renderFrame = (): void => {
    this.animationHandle = null;
    if (this.disposed || !this.needsRender) return;
    this.needsRender = false;
    this.renderer.render(this.scene, this.camera);
  };

  /** Pause rendering when the viewport is scrolled out of view or its tab/page is hidden. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.requestRender();
    else this.stopLoop();
  }

  private stopLoop(): void {
    if (this.animationHandle !== null) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }
  }

  /** Releases every GPU/DOM resource this viewport owns. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    disposeObject3D(this.scene);
    disposeRenderer(this.renderer);
  }
}
