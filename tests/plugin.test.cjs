const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const PREF = "extensions.zotero10-hide-citation-highlights.disableCitationClicks";
const source = fs.readFileSync("bootstrap.js", "utf8");

class Page {
  constructor() { this.items = []; this._lastSignature = "old"; }
  _pushOverlays() { this.items.push("citation-tint"); }
  render() { this.items = ["annotation", "search"]; this._pushOverlays(); }
}

class View {
  constructor() {
    this._pages = [new Page()];
    this.navigations = [];
    this.external = [];
    this.cleanups = 0;
    this.renders = 0;
    // Model a handler bound before the plugin starts, as in the Zotero reader.
    this.pointerUp = this._handlePointerUp.bind(this);
  }
  _getSelectableOverlay(position) { return position?.overlay; }
  _render() { this.renders++; }
  _handlePointerUp(event) {
    const overlay = this._getSelectableOverlay(event.position);
    if (!event.dragged && overlay) {
      if (overlay.type === "citation") this.navigations.push(overlay.references[0].position);
      else if (overlay.type === "internal-link") this.navigations.push(overlay.destinationPosition);
      else if (overlay.type === "external-link") this.external.push(overlay.url);
    }
    this.cleanups++;
  }
}

function fixture(values = new Map()) {
  const readers = [];
  const observers = new Map();
  const timers = new Map();
  const registrations = [];
  const context = vm.createContext({
    Zotero: {
      debug() {},
      Reader: { _readers: readers },
      Prefs: {
        get(key, global) { assert.equal(global, true); return values.get(key); },
        registerObserver(key, callback, global) {
          assert.equal(global, true);
          const id = Symbol();
          observers.set(id, { key, callback });
          return id;
        },
        unregisterObserver(id) { observers.delete(id); },
      },
      PreferencePanes: {
        async register(options) { registrations.push(options); return "test-pane"; },
      },
    },
    Components: { utils: { waiveXrays: value => value } },
    setInterval(callback) { timers.set(0, callback); return 0; },
    clearInterval(id) { timers.delete(id); },
    pref(key, value) { if (!values.has(key)) values.set(key, value); },
  });
  vm.runInContext(fs.readFileSync("prefs.js", "utf8"), context);
  vm.runInContext(source, context);
  const plugin = context.HideCitationHighlights;
  const add = (primary = new View(), secondary = null) => {
    const reader = {
      _iframeWindow: { wrappedJSObject: { Function } },
      _internalReader: { _primaryView: primary, _secondaryView: secondary },
    };
    readers.push(reader);
    return primary;
  };
  const set = value => {
    values.set(PREF, value);
    for (const { key, callback } of observers.values()) if (key === PREF) callback(value);
  };
  return { plugin, context, add, set, values, observers, timers, registrations };
}

const citation = { type: "citation", references: [{ position: { pageIndex: 12 } }] };
const internal = { type: "internal-link", source: "pdf", destinationPosition: { pageIndex: 13 } };
const external = { type: "external-link", url: "https://example.org" };
const click = (view, overlay, dragged = false) => view.pointerUp({ position: { overlay }, dragged });

test("setting defaults off; highlights hide but links remain clickable", async () => {
  const f = fixture();
  const view = f.add();
  const original = view._getSelectableOverlay;
  await f.context.startup();
  assert.equal(f.values.get(PREF), false);
  assert.equal(f.registrations[0].src, "preferences.xhtml");
  assert.equal(f.registrations[0].pluginID, f.plugin.id);
  assert.equal(view._getSelectableOverlay, original);
  assert.deepEqual(view._pages[0].items, ["annotation", "search"]);
  click(view, citation);
  click(view, internal);
  assert.equal(view.navigations.length, 2);
  f.plugin.stop();
});

test("enabling blocks citations and embedded internal links without changing link data", () => {
  const f = fixture();
  const view = f.add();
  const data = JSON.stringify([citation, internal, external]);
  f.plugin.start();
  f.set(true);
  click(view, citation);
  click(view, internal);
  click(view, external);
  click(view, undefined);
  assert.equal(view.navigations.length, 0);
  assert.deepEqual(view.external, [external.url]);
  assert.equal(view.cleanups, 4);
  assert.equal(view._getSelectableOverlay({ overlay: citation }), null);
  assert.equal(view._getSelectableOverlay({ overlay: external }), external);
  assert.equal(JSON.stringify([citation, internal, external]), data);
  // Dragging to select text still reaches the reader's normal pointer-up cleanup.
  click(view, citation, true);
  assert.equal(view.cleanups, 5);
  f.plugin.stop();
});

test("unchecking restores inherited and own methods and keeps highlights hidden", () => {
  const f = fixture();
  const primary = f.add();
  const secondary = new View();
  secondary._getSelectableOverlay = View.prototype._getSelectableOverlay.bind(secondary);
  const own = secondary._getSelectableOverlay;
  f.add(secondary);
  f.plugin.start();
  f.set(true);
  f.set(false);
  assert.equal(Object.hasOwn(primary, "_getSelectableOverlay"), false);
  assert.equal(secondary._getSelectableOverlay, own);
  click(primary, citation);
  click(secondary, internal);
  assert.equal(primary.navigations.length, 1);
  assert.equal(secondary.navigations.length, 1);
  assert.deepEqual(primary._pages[0].items, ["annotation", "search"]);
  f.set(true);
  click(primary, citation);
  assert.equal(primary.navigations.length, 1);
  f.plugin.stop();
});

test("split views, readers opened later, and repeated sweeps follow the setting", () => {
  const f = fixture();
  const secondary = new View();
  const primary = f.add(new View(), secondary);
  f.plugin.start();
  f.set(true);
  const wrapper = primary._getSelectableOverlay;
  f.plugin.sweep();
  assert.equal(primary._getSelectableOverlay, wrapper);
  const later = f.add();
  f.plugin.sweep();
  for (const view of [primary, secondary, later]) {
    click(view, internal);
    assert.equal(view.navigations.length, 0);
  }
  f.set(false);
  for (const view of [primary, secondary, later]) {
    click(view, internal);
    assert.equal(view.navigations.length, 1);
  }
  f.plugin.stop();
});

test("plugin shutdown restores clicks and drawing and clears the observer and timer zero", () => {
  const f = fixture();
  const view = f.add();
  const originalDraw = Page.prototype._pushOverlays;
  f.plugin.start();
  f.plugin.start();
  assert.equal(f.observers.size, 1);
  assert.equal(f.timers.size, 1);
  f.set(true);
  f.plugin.stop();
  assert.equal(Page.prototype._pushOverlays, originalDraw);
  assert.equal(Object.hasOwn(view, "_getSelectableOverlay"), false);
  assert.deepEqual(view._pages[0].items, ["annotation", "search", "citation-tint"]);
  assert.equal(f.observers.size, 0);
  assert.equal(f.timers.size, 0);
  click(view, citation);
  assert.equal(view.navigations.length, 1);
});

test("saved preference survives plugin re-enable", () => {
  const f = fixture();
  const view = f.add();
  f.plugin.start();
  f.set(true);
  f.plugin.stop();
  assert.equal(f.values.get(PREF), true);
  f.plugin.start();
  click(view, citation);
  assert.equal(view.navigations.length, 0);
  f.plugin.stop();
});

test("restoration preserves another plugin's wrapper and deactivates the retained filter", () => {
  const f = fixture();
  const view = f.add();
  f.plugin.start();
  f.set(true);
  const previous = view._getSelectableOverlay;
  const otherWrapper = function (...args) { return previous.apply(this, args); };
  view._getSelectableOverlay = otherWrapper;
  f.set(false);
  assert.equal(view._getSelectableOverlay, otherWrapper);
  click(view, citation);
  assert.equal(view.navigations.length, 1);
  f.set(true);
  click(view, citation);
  assert.equal(view.navigations.length, 1);
  f.plugin.stop();
  assert.equal(view._getSelectableOverlay, otherWrapper);
  click(view, citation);
  assert.equal(view.navigations.length, 2);
});

test("enabling closes an existing citation preview; disabling is safe for other reader types", () => {
  const f = fixture();
  const view = f.add();
  let popup;
  let closed = 0;
  view._selectedOverlay = citation;
  view._overlayPopupDelayer = { close() { closed++; } };
  view._onSetOverlayPopup = value => { popup = value; };
  f.plugin.start();
  f.set(true);
  assert.equal(popup, null);
  assert.equal(closed, 1);
  assert.equal(view._selectedOverlay, null);
  const worker = new Function("view", "disableClicks", f.plugin.SET_CLICKS_BODY);
  worker({}, true);
  worker({ _pages: [] }, true);
  f.plugin.stop();
});
