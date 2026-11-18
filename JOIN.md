# Join the bb hub

The hub installs the local, remote, and marketplace plugins in
[`packages.json`](packages.json) and
keeps them, and itself, up to date. Everything lives in this public
repository, so **no GitHub token or login is needed**.

## Before you start

- bb 0.47.1 or newer, running. Check with `bb --version`.
- `git` on the machine that runs the bb server.

## Install

```sh
bb plugin install git:https://github.com/Timmmmmmer/bb-plugins.git --subdirectory plugins/hub --yes
```

That's all. The hub starts a sync right away and installs every plugin. Check
it with:

```sh
bb hub status
bb hub sync
```

Every plugin should say `installed` or `current`, and the last line should
say `hub (self) current`. The **Plugin hub** page in the bb sidebar shows the
same information, plus every plugin folder in the repository with an Install
button.

## Groups

Everyone gets the **Home** group. To also get a team's plugins, subscribe to
its group:

```sh
bb hub group                                         # list groups and your subscriptions
bb hub group subscribe lean-software-developers
bb hub group subscribe lean-software-student
bb hub group unsubscribe lean-software-student       # its plugins stay installed, but stop updating
```

The Plugin hub page has the same choice in the selector at the top. Whatever
you add or delete on the page goes to the group selected there. On the CLI,
use `--group <id>`, e.g. `bb hub plugin add ~/code/my-plugin --group lean-software-student`.

If the same plugin is in more than one of your groups, the newest version wins.
If you already have it from one group and a newer copy appears in another, the
hub tells you instead of switching (switching reinstalls the plugin, which
resets its data). `bb hub adopt <folder>` switches when you're ready.

### Moving a plugin to another group

Use the ⇄ button on a plugin's row (it asks which group), or:

```sh
bb hub plugin move hello --to lean-software-developers              # a local plugin
bb hub plugin move someone/bb-plugin-x --from home --to lean-software-student   # a remote plugin
bb hub marketplace move bb-sidebar@bb-community --to lean-software-student
```

- **Remote and marketplace plugins:** only their entry moves. Nothing is
  reinstalled and no data is lost.
- **Local plugins:** the new group takes the plugin over, but its folder stays
  where it is (the new group lists it under `"local"`, the old group under
  `"exclude"`). Nothing is reinstalled and no data is lost.
- Machines subscribed only to the old group keep the plugin, but it stops
  updating.

## Team marketplace

The hub also adds this repository's [`marketplace.json`](marketplace.json) to
**Settings → Plugin marketplaces** (as "Team plugins"), so its plugins show up
in bb's plugin store too. To add it by hand on a machine without the hub:

```sh
bb marketplace add git:https://github.com/Timmmmmmer/bb-plugins.git
```

Turn the automatic step off with `bb plugin config hub set registerMarketplace false`.

## On a server

The hub keeps a small git mirror of this repository. By default it goes in
bb's data directory. If that directory isn't writable for the bb server, the
hub falls back to `~/.cache/bb-plugin-hub/mirrors`, then the temp folder.
`bb hub status` shows which one it uses. For a fixed location:

```sh
bb plugin config hub set mirrorsDir /var/lib/bb-hub/mirrors   # owned by the bb server's user
```

## When changes arrive

Every hub syncs at the same moments: every `syncIntervalMinutes` (in
`packages.json`, currently 15), aligned to UTC. A change pushed at least 60
seconds before a sync reaches every running hub at that sync, at most 16
minutes later. `bb hub status` and the Plugin hub page show the exact time.
Only plugins whose own folder changed are updated, so editing one plugin
doesn't reload the others. A hub that's switched off catches up when it
starts.

## Troubleshooting

| You see | What to do |
|---|---|
| `other-source` | You already had that plugin from elsewhere. `bb hub adopt <folder>` (e.g. `bb hub adopt hello`) switches it to this repository, but deletes that plugin's settings and data. |
| `Could not read … from GitHub` | The machine can't reach github.com, or the repository isn't public. |
| `No writable folder for the hub's mirror` | Set `mirrorsDir` as in *On a server*. |
| `bb: command not found` | Your terminal can't find bb. Install it with `npm install -g bb-app@<your bb version>`, or use the `bb` that bb's own terminals provide. |

## Maintainers

- **Add a plugin:** `bb hub plugin add <source>` or the **Add a plugin** box
  on the Plugin hub page.
  - A **public** git repo (`owner/name`, an https URL, or a GitHub folder link)
    becomes a **remote plugin**: nothing is copied; `packages.json` points to
    it and every hub installs it from there. Private repositories are refused.
  - A folder or `.zip`/`.tar` (file, URL, or dropped on the page, up to 8 MB)
    is copied into `plugins/` as a **local plugin**, without `node_modules`,
    `dist`, `.git`, or `.env`. Uploading the folder on GitHub, or
    `scripts/add-plugin.sh <folder | .zip>`, does the same.

  Either way it pushes with the git login of the machine running bb (run
  `gh auth setup-git` there if pushing fails). Every running hub installs it at
  the next sync.
- **Add a plugin from bb's marketplaces** (bb-community, bb-official, or a
  third-party one): `bb hub marketplace search <words>`, then
  `bb hub marketplace add <id>@<marketplace>`. The Plugin hub page has the
  same search with **Add for everyone**. Every hub installs it through bb's
  own catalog and keeps it updated. A third-party marketplace is registered
  automatically on machines that don't have it. `bb hub marketplace remove <id>`
  takes it off the list (it stays installed).
- **Stop installing one:** for a remote plugin, `bb hub plugin remove <repo>`
  (or ✕ on the page); machines keep it installed but stop updating it.
- **Delete a local plugin:** the 🗑 button on the page (it asks to confirm),
  or `bb hub plugin delete <folder> --yes`. This removes the folder from the
  repository and puts its id on `packages.json`'s `uninstall` list, so **every
  hub uninstalls it, and its data and settings are lost on every machine**.
  Adding a plugin with that id again takes it off the list. (Only deleting
  the folder by hand on GitHub, or adding it to `exclude`, leaves it installed
  but no longer updated.)
- Every plugin needs a distinct plugin id (the `name` in its `package.json`).
  Adding a duplicate is refused, and the hub reports a second one as `failed`.
- **Ship an update:** push to the plugin: its folder here, or its own
  repository for a remote plugin.

Anyone who can push to this repository changes what every member's hub
installs, so keep write access to a few people, and review pull requests
before merging.

## Security

The hub stores no secrets. bb runs every plugin with full trust, so only
install plugins you trust. The hub refuses calls from other plugins, so they
can't use it to install code.

## Leaving

`bb plugin remove hub` removes the hub. Plugins it installed keep running but
stop updating; remove them with `bb plugin remove <id>`.
