# Changelog

## 0.3.0 — Optional click blocking

- Add a settings pane with an optional, persistent click-blocking setting (off by default).
- Disable citation and PDF internal-link clicks and hover previews when enabled.
- Preserve external web links, text selection, annotations, and PDF link data.
- Apply setting changes to open and future readers, including split views.
- Restore link interactions when the setting is turned off or the plugin is disabled.
- Include preference defaults and the settings pane in local and CI packages.

- Translate all project documentation into English and keep source attribution brief.
- Correct update-manifest compatibility metadata to use applications.zotero for Zotero 7 and later.
- Update checkout and artifact upload actions to v7 and the release action to v3.
- Add Ubuntu and Windows CI builds with JavaScript syntax and package checks.
- Use the fixed package name `zotero10-hide-citation-highlights.xpi` in local builds and GitHub releases.
- Validate stable release tags, plugin metadata, and the repository update URL before publication.
- Serialize release runs, generate update manifests with JSON serialization, and fail if release assets are missing.
- Check the Git checkout, working tree, and push target before the release helper changes files.

## 0.2.0 — Zotero 10 adaptation

- Add `Page._pushOverlays()` support for DOM citation boxes in Zotero 10.0.3.
- Reset `_lastSignature` when refreshing pages in the new reader and restore the original methods when disabled.
- Retain the Zotero 7–9 `Renderer._drawOverlays()` implementation.
- Raise the maximum compatible version to `10.0.*`.
- Prevent duplicate timers and correctly clear a timer whose ID is 0.
- Add a Windows PowerShell packaging script.
- Use an independent plugin ID and the XuebaStudy repository update URL while retaining original attribution.
- Include source attribution and copyright information in the package.

Verification: Automated checks using the actual Page rendering methods from the locally installed Zotero 10.0.3 and package validation have passed. Installation and interaction testing in the interface is still pending. No remote release has been performed.
