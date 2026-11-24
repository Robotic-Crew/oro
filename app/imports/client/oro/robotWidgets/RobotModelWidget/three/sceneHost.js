/**
 * Copyright 2026 InOrbit, Inc.
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

/**
 * One WebGL renderer for every 3D view on the page.
 *
 * Browsers cap live WebGL contexts (~16), and a dashboard may hold several 3D widgets, so views
 * don't own a context: each one has a plain 2D canvas, and this host renders the view's scene in
 * an offscreen WebGL canvas and copies the pixels over. Rendering is on demand: a view is drawn
 * only after `invalidate()` (new joint values, camera moved, resized), and a view that is
 * animating asks for the next frame from its `onFrame` hook. Nothing renders while idle, while the
 * tab is hidden, or for views scrolled out of sight.
 *
 * A view is an object { canvas, scene, camera, width, height, visible, background, onFrame? },
 * where `onFrame(now)` returns { changed, animating }.
 */
import { WebGLRenderer, SRGBColorSpace, Vector2 } from 'three';

const MAX_PIXEL_RATIO = 2;

class SceneHost {
  constructor() {
    this._views = new Set();
    this._dirty = new Set();
    this._renderer = null;
    this._rafId = null;
    this._contextLost = false;
    this._size = new Vector2();
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  register(view) {
    this._views.add(view);
    this.invalidate(view);
  }

  unregister(view) {
    this._views.delete(view);
    this._dirty.delete(view);
    if (this._views.size === 0) {
      this._dispose();
    }
  }

  /** Schedules a redraw of `view` on the next animation frame. */
  invalidate(view) {
    this._dirty.add(view);
    this._schedule();
  }

  _schedule() {
    if (this._rafId === null) {
      this._rafId = requestAnimationFrame(this._frame);
    }
  }

  _frame = (now) => {
    this._rafId = null;
    if (document.hidden || this._contextLost) {
      // _onVisibilityChange / context restore redraw everything later
      return;
    }
    // Animating views update their scene (e.g. interpolated joints) and ask for more frames
    let animating = false;
    this._views.forEach((view) => {
      if (view.onFrame && view.visible) {
        const result = view.onFrame(now);
        if (result.changed) {
          this._dirty.add(view);
        }
        animating = animating || result.animating;
      }
    });
    const dirty = [...this._dirty];
    this._dirty.clear();
    dirty.forEach((view) => {
      if (this._views.has(view) && view.visible) {
        this._render(view);
      }
    });
    if (animating) {
      this._schedule();
    }
  };

  _getRenderer() {
    if (!this._renderer) {
      this._renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
      this._renderer.outputColorSpace = SRGBColorSpace;
      this._renderer.setScissorTest(true);
      const canvas = this._renderer.domElement;
      canvas.addEventListener('webglcontextlost', (e) => {
        // Also fired by our own _dispose(); only a loss on the live renderer matters
        if (this._renderer?.domElement === canvas) {
          e.preventDefault();
          this._contextLost = true;
        }
      });
      canvas.addEventListener('webglcontextrestored', () => {
        this._contextLost = false;
        this._views.forEach((v) => this.invalidate(v));
      });
    }
    return this._renderer;
  }

  _render(view) {
    const { canvas, scene, camera, width, height, background } = view;
    if (width < 1 || height < 1) {
      return;
    }
    const renderer = this._getRenderer();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    // The offscreen canvas only grows: one size big enough for the largest view
    const size = renderer.getSize(this._size);
    if (renderer.getPixelRatio() !== pixelRatio || size.x < width || size.y < height) {
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(Math.max(size.x, width), Math.max(size.y, height), false);
    }
    const hostHeight = renderer.getSize(this._size).y;
    // WebGL's origin is bottom-left: draw in the top-left corner, which is what drawImage copies
    renderer.setViewport(0, hostHeight - height, width, height);
    renderer.setScissor(0, hostHeight - height, width, height);
    renderer.setClearColor(background);
    renderer.render(scene, camera);

    const pw = Math.round(width * pixelRatio);
    const ph = Math.round(height * pixelRatio);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(renderer.domElement, 0, 0, pw, ph, 0, 0, pw, ph);
  }

  _onVisibilityChange = () => {
    if (!document.hidden) {
      this._views.forEach((v) => this.invalidate(v));
    }
  };

  _dispose() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._renderer) {
      this._renderer.dispose();
      this._renderer.forceContextLoss();
      this._renderer = null;
      this._size.set(0, 0);
    }
  }
}

let instance = null;
/** The page-wide host. */
const getSceneHost = () => {
  if (!instance) {
    instance = new SceneHost();
  }
  return instance;
};

export default getSceneHost;
