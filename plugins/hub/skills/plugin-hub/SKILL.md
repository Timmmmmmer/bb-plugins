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
bb hub marketplace [--json]                   # marketplace plugins every hub installs
bb hub marketplace search <words> [--json]    # find entries in bb's marketplaces
bb hub marketplace add <id>[@<marketplace>]   # add to packages.json for everyone (commits + pushes)
bb hub marketplace remove <id>[@<marketplace>] # take it off the list (machines keep it installed)
bb hub plugin add <source> [--subdir <path>] [--name <folder>] [--force] [--json]
                            # public repo → remote plugin (pointed to); folder or .zip/.tar → local plugin (copied in)
bb hub plugin remove <repo> [--path <folder>]   # stop pointing to a remote plugin (stays installed)
bb hub plugin delete <folder> --yes             # delete a local plugin AND uninstall it everywhere (data lost)
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

## Marketplace plugins

`packages.json` has a separate `marketplace` list for plugins from bb's
marketplaces:

```json
"marketplace": [
  { "id": "thread-hover-cards", "marketplace": "bb-community" },
  { "id": "notes", "marketplace": "acme-plugins", "source": "git:github.com/acme/bb-marketplace@main" }
]
```

On every sync each entry is resolved with bb's catalog (`installPlan`) and,
when missing, installed with `catalog.install` and the exact resolved source.
When installed, bb's update check runs and available updates are applied. A
third-party marketplace with a recorded `source` is added on machines that
don't have it. `bb hub marketplace add` validates the entry first, records
the marketplace's source for third-party marketplaces, commits, pushes with
the machine's git, and syncs. `remove` commits the removal; the plugin stays
installed. Both publish to the shared repository and affect every member, so
confirm with the user first. Results appear as `marketplace:<id>@<marketplace>`
in `bb hub sync`.

## Local, remote, and marketplace plugins

- **Local plugins**: folders under `include` (`plugins/*`) of the shared
  repository.
- **Remote plugins**: `packages.json` `"remote"` entries
  `{ "repo": "owner/name" | "https://…", "path"?: "folder", "ref"?: "…" }`.
  bb installs them straight from that repository (with `path` as the
  subdirectory; omitted means the root), and updates them only when that
  folder changes. **Only public repositories work**: the hub reads anonymously,
  and adding a private or missing repository fails with "it's private or
  doesn't exist". SSH URLs are refused; use https. A GitHub folder link
  (`https://github.com/o/r/tree/main/plugins/x`) gives the path and branch.
  The older `"plugins"` key is still read as remote entries.
- **A repository with several plugins and its own `marketplace.json`**
  (bb marketplace format, at its root or in the folder given): `bb hub plugin
  add <repo>` registers that marketplace with bb and adds **every plugin it
  lists** as marketplace entries (`{ "id", "marketplace": "<its name>",
  "source": "git:<repo url>", "subdirectory"? }`), so bb installs them from
  their released tags, the way its own marketplace does; other hubs register
  the marketplace at their next sync. Adding one plugin folder of such a repo
  uses the marketplace when it lists that folder (`source.git.subdir`), and
  otherwise falls back to a remote entry with a note. Plugins added to the
  marketplace later are not picked up automatically; add the repo again.
- `bb hub plugin add` decides by source: a git repository (owner/name, https
  URL; an existing local folder named like owner/name stays a folder) is
  added as a remote entry, with nothing copied. Folders and archives are
  copied into `plugins/<folder>` as local plugins.
- **Marketplace plugins**: see above.

## Deleting a local plugin

`bb hub plugin delete <folder> --yes` (or the page's 🗑 button, which shows a
confirmation) removes `plugins/<folder>` from the shared repository and adds
its plugin id to `packages.json` `"uninstall"`. Every hub then uninstalls that
plugin at its next sync with `bb plugin remove`, which **deletes the plugin's
data and settings on every machine**. A hub only uninstalls a plugin it
installed from the shared repository, and never while a package with that id
is still listed. Adding a plugin with that id again (local, remote, or
marketplace) takes it off the list. This is irreversible for every member:
always confirm with the user before passing `--yes`.

## Team marketplace (Settings → Plugin marketplaces)

The shared repository has a generated `marketplace.json` (bb marketplace
schema v1, name `bb-plugins`) listing every local plugin (the hub included)
and every remote plugin on GitHub. `scripts/build-marketplace.mjs` builds it,
and `.github/workflows/marketplace.yml` reruns it on every push. Never edit it
by hand. On each sync the hub adds it with
`marketplaces.add({ source: "git:https://github.com/<owner>/<repo>.git" })`
when it's missing, and refreshes it when the repository's commit changed
(setting `registerMarketplace`, on by default). It then appears in Settings →
Plugin marketplaces and in `bb plugin search`.

## Groups

The repository root is the **home** group (always installed). The root
`packages.json` lists other groups:
`"groups": [{ "id": "lean-software-developers", "name": "…", "path": "groups/lean-software-developers" }, …]`.
Each group folder has its own `packages.json` (include/exclude relative to the
folder, `remote`, `marketplace`, `uninstall`), `plugins/<name>/`, and
generated `marketplace.json` (named `bb-plugins-<id>`).

```sh
bb hub group [--json]               # groups and this machine's subscriptions
bb hub group subscribe <id>         # install and update that group's plugins here
bb hub group unsubscribe <id>       # stop (its plugins stay installed); its marketplace leaves Settings
bb hub packages [--group <id>]      # what each subscribed group lists
bb hub group add <name> [--id <id>] # new empty group in groups/<id> (id from the name by default)
bb hub group rename <id> <name>     # display name only; id, folder and subscriptions stay (home too)
bb hub group remove <id>            # only an empty group: move or delete its plugins first
```

A group's id and folder never change: machines subscribe by id and its
marketplace is named after it. Removing a group drops it from the root
`packages.json` and deletes its folder; subscribed hubs take its marketplace out
of Settings at their next sync (the machine that removed it, right away). The
Plugin hub page has ✎ (rename), 🗑 (remove) and + (add) next to the group
selector.

Every command that changes the repository takes `--group <id>` (default home):
`plugin add/remove/delete`, `marketplace add/remove`, `list`, `marketplace`.
Subscriptions are the `groups` setting (comma-separated ids).

Clashes: when one plugin id is listed in several subscribed groups (or twice
in one), the candidate with the highest `version` in its package.json wins;
on a tie, the home group, then group order. The others report `skipped` with
the winner. A plugin already installed from another folder of the same
repository is reported `other-source` with a `bb hub adopt <folder>` hint and is
never switched automatically, because switching reinstalls it and resets its
data. A group's `uninstall` list only removes plugins installed from that
group's own folders.

### Moving between groups

```sh
bb hub plugin move <folder|name|repo> --to <group> [--from <group>] [--path <folder>]
bb hub marketplace move <id>[@<marketplace>] --to <group> [--from <group>]
```

One commit moves the plugin, and the page's ⇄ button does the same. **Nothing
is reinstalled and no data is lost**, for every kind of plugin:
- **local:** the folder stays put. The new group lists it in its
  packages.json `"local": [{ "path": "<folder from repo root>" }]`, and the old
  group stops listing it: an `"exclude"` entry if the folder is in its own
  `plugins/`, otherwise it leaves its `"local"` list. Moving it back to the
  group whose `plugins/` holds it just removes the exclude. Installed copies
  keep their folder, so they don't change.
- **remote / marketplace:** the packages.json entry moves.

Machines subscribed only to the old group keep the plugin, but it stops
updating. A moved-in id leaves the destination's `uninstall` list. The hub
can't be moved. Deleting a moved plugin (from its owning group) removes the
folder, and hubs uninstall a deleted plugin only when the exact folder they
installed it from is gone from the repository. If a folder is ever moved by
hand (`git mv`), hubs reinstall from the new folder, which resets that
plugin's data.
