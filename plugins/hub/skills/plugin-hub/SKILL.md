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
bb hub plugin add <source> [--name <folder>] [--subdir <path>] [--force] [--json]
                            # add a plugin to the shared repo from a git URL, a folder, or a .zip/.tar file or URL
```

`bb hub plugin add` (and the page's **Add a plugin** card, which also accepts
an uploaded folder or `.zip` up to 8 MB) copies the plugin into
`plugins/<folder>`, leaving out node_modules, dist, .git, .claude, .env files,
and symlinks. It checks the manifest (`name`, `bb.name`, `bb.description`,
`bb.server`, `bb.branding`) and refuses a plugin id another folder already
uses. Then it commits and pushes **with the git credentials of the machine
running bb** (the hub stores none), and syncs. It publishes to a public
repository and changes what every member installs, so confirm with the user
before running it. Local paths and archives are read on the machine running bb.

## packages.json

```json
{
  "syncIntervalMinutes": 15,
  "include": ["plugins/*"],
  "exclude": ["plugins/experimental"],
  "plugins": [
    { "path": "tools/x", "repo": "someone/public-repo", "ref": "semver:x/:^1.0.0" }
  ]
}
```

- `include`: every subfolder of `<folder>/*` with a `package.json` that has a
  `"bb"` section is a package (the hub's own folder is skipped). So **adding a
  plugin is just adding a folder** under `plugins/`.
- `exclude`: folders to leave out.
- `plugins`: extra entries; `path` is required, and `repo` (another public
  repository) and `ref` (branch, tag, or `semver:[prefix:]range`) are optional.

To add a plugin from any source, run `scripts/add-plugin.sh <source>` in a
clone of the repository. The source can be a local folder, a git URL, or a
`.zip`/`.tar.gz` file or URL; `--subdir` picks a folder, `--name` the target
folder, and `--no-push` commits without pushing. The script copies without
`node_modules`/`dist`/`.git`/`.env`, validates the manifest, refuses duplicate
plugin ids, then commits and pushes. Uploading the folder on GitHub works too.
`bb hub plugin add` does the same from bb.

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
