/* Zotero Hide Citation Highlights — Zotero 7+ bootstrap plugin
 * Original plugin: jkroes/zotero-hide-citation-highlights.
 * Zotero 10 adaptation maintained independently by XuebaStudy.
 * See ATTRIBUTION.md and COPYRIGHT.md for provenance and permission status.
 *
 * WHAT THIS HIDES
 *   The light-blue boxes the Zotero PDF reader paints over detected citations
 *   and cross-reference (internal) links — e.g. the author/year citations a
 *   LaTeX `hyperref` document embeds. Links stay clickable and their popups
 *   still work; only the persistent painted box is removed.
 *
 * Zotero 10.0.3 uses Page._pushOverlays() to build DOM overlays instead of
 * Renderer._drawOverlays(). Patch only the citation tint pass in either
 * implementation; leave user annotations and hover feedback intact.
 *
 * LEGACY READER DETAILS (Zotero 7–9)
 *   1. No DOM. Zotero's reader does NOT use PDF.js's DOM annotation layer. It
 *      paints these boxes straight onto a <canvas> with ctx.fillRect() in
 *      Renderer._drawOverlays(). There is nothing to style, so CSS / agent
 *      sheets can never touch them.
 *   2. Xray boundary. The reader runs in an iframe (content scope); plugin
 *      code runs privileged (chrome scope). Reaching content objects from
 *      chrome goes through Xray wrappers that HIDE the reader's own methods,
 *      so a chrome-side monkeypatch silently writes an invisible expando. We
 *      therefore build a function in the reader's OWN compartment
 *      (cw.wrappedJSObject.Function) and do all the work there.
 *   3. Wrong class. _drawOverlays is on the Renderer class, not Page. Each
 *      Page holds renderer instances (_pageRenderer / _detailRenderer); we
 *      find their prototype by scanning the page's own object fields.
 *   4. Signature cache. Renderer.render() skips repainting when its content
 *      digest is unchanged (Renderer._lastRenderSignature). No-oping the draw
 *      doesn't change the digest, so we must _invalidateSignature() before
 *      render() or the box never clears.
 *
 *   The shipped reader is minified but does not mangle property names, so
 *   _drawOverlays / _invalidateSignature / _pages / _primaryView /
 *   _internalReader / _iframeWindow are stable. Everything is reversible:
 *   shutdown restores the original method and repaints.
 */

var HideCitationHighlights = {
  id: "zotero10-hide-citation-highlights@XuebaStudy",
  timer: null,
  _win: null,
  _workers: null, // WeakMap<readerWindow, contentFunction>

  log(msg) {
    try { Zotero.debug("[HideCitationHighlights] " + msg); } catch (e) {}
  },

  // Runs in the reader's own compartment. For each page: find the renderer
  // prototype(s), install a no-op _drawOverlays once, and on first sight of a
  // page invalidate its renderer signatures and repaint so existing boxes
  // clear. Idempotent — repeat passes are near no-ops.
  PATCH_BODY: `
    if (!view || !view._pages || !view._pages.length) return 0;
    var patched = 0;
    for (var k = 0; k < view._pages.length; k++) {
      var page = view._pages[k];
      var done = page.__hideLinks_done;
      // Zotero 10: the overlay display list is built directly on Page.
      var pageProto = Object.getPrototypeOf(page);
      if (pageProto && typeof pageProto._pushOverlays === "function") {
        if (!Object.prototype.hasOwnProperty.call(pageProto, "__hideLinks_origPush")) {
          pageProto.__hideLinks_origPush = pageProto._pushOverlays;
          pageProto._pushOverlays = function () {};
          patched++;
        }
        if (!done) {
          page._lastSignature = null;
          try {
            page.render();
            page.__hideLinks_done = true;
          } catch (e) {}
        }
        continue;
      }
      var names = Object.getOwnPropertyNames(page);
      for (var i = 0; i < names.length; i++) {
        var val;
        try { val = page[names[i]]; } catch (e) { continue; }
        if (!val || typeof val !== "object") continue;
        var p = Object.getPrototypeOf(val);
        if (!p || !Object.prototype.hasOwnProperty.call(p, "_drawOverlays")) continue;
        if (!p.__hideLinks_orig) {
          p.__hideLinks_orig = p._drawOverlays;
          p._drawOverlays = function () {};
          patched++;
        }
        if (!done && typeof val._invalidateSignature === "function") {
          try { val._invalidateSignature(); } catch (e) {}
        }
      }
      if (!done) {
        page.__hideLinks_done = true;
        try { page.render(); } catch (e) {}
      }
    }
    return patched;
  `,

  // Restore the original draw method on every patched renderer prototype and
  // repaint so the boxes come back.
  RESTORE_BODY: `
    if (!view || !view._pages) return;
    for (var k = 0; k < view._pages.length; k++) {
      var page = view._pages[k];
      var pageProto = Object.getPrototypeOf(page);
      if (pageProto && Object.prototype.hasOwnProperty.call(pageProto, "__hideLinks_origPush")) {
        pageProto._pushOverlays = pageProto.__hideLinks_origPush;
        delete pageProto.__hideLinks_origPush;
      }
      if ("_lastSignature" in page) page._lastSignature = null;
      var names = Object.getOwnPropertyNames(page);
      for (var i = 0; i < names.length; i++) {
        var val;
        try { val = page[names[i]]; } catch (e) { continue; }
        if (!val || typeof val !== "object") continue;
        var p = Object.getPrototypeOf(val);
        if (p && p.__hideLinks_orig) {
          p._drawOverlays = p.__hideLinks_orig;
          delete p.__hideLinks_orig;
        }
        if (typeof val._invalidateSignature === "function") {
          try { val._invalidateSignature(); } catch (e) {}
        }
      }
      delete page.__hideLinks_done;
      try { page.render(); } catch (e) {}
    }
  `,

  // Build (and cache) a function compiled in the reader window's own scope.
  worker(cw, body, cacheKey) {
    if (!cw || !cw.wrappedJSObject) return null;
    if (cacheKey) {
      let cached = this._workers.get(cw);
      if (cached && cached[cacheKey]) return cached[cacheKey];
    }
    let fn = new cw.wrappedJSObject.Function("view", body);
    if (cacheKey) {
      let bag = this._workers.get(cw) || {};
      bag[cacheKey] = fn;
      this._workers.set(cw, bag);
    }
    return fn;
  },

  runOnReader(reader, body, cacheKey) {
    try {
      const Cu = Components.utils;
      const cw = reader && reader._iframeWindow;
      const fn = this.worker(cw, body, cacheKey);
      if (!fn) return;
      const ir = Cu.waiveXrays(reader._internalReader);
      if (!ir) return;
      for (const rawView of [ir._primaryView, ir._secondaryView]) {
        if (rawView) {
          try { fn(Cu.waiveXrays(rawView)); } catch (e) { this.log("view error: " + e); }
        }
      }
    } catch (e) {
      this.log("runOnReader error: " + e);
    }
  },

  sweep() {
    try {
      const readers = Zotero.Reader && Zotero.Reader._readers;
      if (!readers) return;
      for (const reader of readers) this.runOnReader(reader, this.PATCH_BODY, "patch");
    } catch (e) {
      this.log("sweep error: " + e);
    }
  },

  start() {
    if (this.timer !== null) return;
    this._workers = new WeakMap();
    this.sweep();
    // Pages render asynchronously after a reader opens, and readers open at
    // any time, so poll. Once everything is patched, passes are near no-ops.
    if (typeof setInterval !== "undefined") {
      this._win = { setInterval, clearInterval };
    } else {
      this._win = Zotero.getMainWindow();
    }
    this.timer = this._win.setInterval(() => this.sweep(), 1000);
  },

  stop() {
    try {
      if (this.timer !== null && this._win) this._win.clearInterval(this.timer);
    } catch (e) {}
    this.timer = null;
    try {
      for (const reader of (Zotero.Reader && Zotero.Reader._readers) || []) {
        this.runOnReader(reader, this.RESTORE_BODY, null);
      }
    } catch (e) {}
    this._workers = null;
  },
};

function startup() {
  HideCitationHighlights.start();
}

function shutdown() {
  HideCitationHighlights.stop();
}

function install() {}
function uninstall() {}
