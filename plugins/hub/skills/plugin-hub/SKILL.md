---
name: plugin-hub
description: Check, install, and update the team's bb plugins from the shared public repository (Timmmmmmer/bb-plugins) with the `bb hub` CLI. Use when the user asks which shared plugins are installed or available, to install, update, or adopt one, when a pushed change will reach everyone, or how to add or remove a shared package.
---

# Plugin hub

The Hub plugin keeps the plugins listed in `packages.json` of a public
repository (setting `packagesRepo`, default `Timmmmmmer/bb-plugins`)
installed and up to date. Each plugin is a folder, `plugins/<name>/`. No
tokens: bb installs each plugin from
`git:https://github.com/<owner>/<repo>.git` with the folder as subdirectory.

```sh
bb hub status [--json]      # shared schedule, when a change reaches every hub, mirror folder
bb hub sync [--json]        # install missing packages and update changed ones now
bb hub packages [--json]    # what packages.json lists
bb hub list [--json]        # every plugin folder in the repo, installed or not
bb hub install <folder>     # e.g. bb hub install hello (or plugins/hello); updates if installed
bb hub adopt <folder>       # switch a plugin installed elsewhere; DELETES its settings and data, so confirm first
```

## packages.json

```json
{
  "syncIntervalMinutes": 15,
  "plugins": [
    { "path": "plugins/hello" },
    { "path": "tools/x", "repo": "someone/public-repo", "ref": "semver:x/:^1.0.0" }
  ]
}
```

`path` is required. `repo` (another public repository) and `ref` (branch, tag,
or `semver:[prefix:]range`) are optional. To add or remove a package, edit the
file and push. The hub has no command for that, because pushing needs the
maintainer's own git access.

## Sync behaviour

- Every hub syncs at multiples of `syncIntervalMinutes` since the Unix epoch
  (UTC-aligned, the same moment everywhere), and also at startup, on settings
  changes, and on `bb hub sync`. A change on GitHub at least 60 seconds before
  a boundary reaches every running hub at that boundary.
- A plugin is updated only when its own folder changed between the installed
  and the latest commit (the hub compares the folder's git tree in its mirror).
  Otherwise it reports `current (no changes in <folder>)`.
- The hub updates itself the same way (its folder is `hubPath`, default
  `plugins/hub`) as a bb update job after the sync. A version bb rolled back
  is not retried.
- Outcomes: `installed`, `updated`, `current`, `pinned`, `skipped`,
  `other-source` (installed some other way; `bb hub adopt` fixes it after
  confirming with the user), `updating`, `failed`.

## Mirror folder

The hub keeps a git mirror of the repository in the `mirrorsDir` setting, or
else the first writable of bb's data dir (`plugins/hub/mirrors`),
`~/.cache/bb-plugin-hub/mirrors`, and the temp folder. `bb hub status` shows it.
