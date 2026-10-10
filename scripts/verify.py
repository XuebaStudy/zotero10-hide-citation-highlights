"""Validate plugin metadata and built packages using only the standard library."""

import argparse
import json
import re
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
FILES = ("manifest.json", "bootstrap.js", "ATTRIBUTION.md", "COPYRIGHT.md", "prefs.js", "preferences.xhtml")
VERSION = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Stable release tag, such as v0.3.0")
    parser.add_argument("--repository", help="GitHub owner/repository")
    parser.add_argument("--xpi", type=Path, help="Package to compare with source files")
    parser.add_argument("--updates", type=Path, help="Write an update manifest (requires tag and repository)")
    parser.add_argument("--github-output", type=Path, help="Append build metadata to GITHUB_OUTPUT")
    args = parser.parse_args()

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8-sig"))
    version = manifest["version"]
    require(isinstance(version, str) and re.fullmatch(VERSION, version),
            "Manifest version must be a stable X.Y.Z version")
    require(manifest["manifest_version"] == 2, "Expected manifest_version 2")
    zotero = manifest["applications"]["zotero"]
    for key in ("id", "update_url", "strict_min_version", "strict_max_version"):
        require(isinstance(zotero[key], str) and bool(zotero[key]) and
                "\n" not in zotero[key] and "\r" not in zotero[key],
                f"Invalid Zotero metadata: {key}")
    bootstrap = (ROOT / "bootstrap.js").read_text(encoding="utf-8-sig")
    require(f'id: {json.dumps(zotero["id"])}' in bootstrap,
            "Plugin ID differs between manifest.json and bootstrap.js")
    for name in FILES:
        require((ROOT / name).is_file(), f"Missing package source: {name}")

    if args.tag:
        require(args.tag == f"v{version}", "Release tag must be v followed by the manifest version")
    if args.repository:
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository),
                "Invalid GitHub repository name")
        expected = f"https://github.com/{args.repository}/releases/download/release/updates.json"
        require(zotero["update_url"].lower() == expected.lower(),
                "Manifest update_url does not match the publishing repository")

    if args.xpi:
        with ZipFile(args.xpi) as archive:
            require(sorted(archive.namelist()) == sorted(FILES),
                    "Package must contain exactly the required files at its root")
            require(archive.testzip() is None, "Package CRC check failed")
            for name in FILES:
                require(archive.read(name) == (ROOT / name).read_bytes(),
                        f"Packaged file differs from source: {name}")

    xpi_name = "zotero10-hide-citation-highlights.xpi"
    if args.updates:
        require(args.tag and args.repository and args.xpi,
                "Writing updates requires --tag, --repository, and --xpi")
        require(args.xpi.name == xpi_name, "Unexpected release package name")
        updates = {"addons": {zotero["id"]: {"updates": [{
            "version": version,
            "update_link": f"https://github.com/{args.repository}/releases/download/{args.tag}/{xpi_name}",
            "applications": {"zotero": {
                "strict_min_version": zotero["strict_min_version"],
                "strict_max_version": zotero["strict_max_version"],
            }},
        }]}}}
        args.updates.write_text(json.dumps(updates, indent=2) + "\n", encoding="utf-8")
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as output:
            output.write(f"version={version}\nxpi_name={xpi_name}\n")
    print(f"Verified plugin {version}" + (f" and package {args.xpi}" if args.xpi else ""))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(f"Verification failed: {error}") from error
