# bb-plugins

Shared [bb](https://getbb.app) plugins, one per folder, plus the **hub** that
installs them and keeps them up to date on every member's machine.

| Folder | Plugin |
|---|---|
| [`plugins/hub`](plugins/hub) | **Hub**: installs the local, remote, and marketplace plugins in [`packages.json`](packages.json), updates them, and updates itself |
| [`plugins/hello`](plugins/hello) | **Hello**: an example todo list (`bb hello`) |
| [`plugins/sidebar-text`](plugins/sidebar-text) | **Sidebar text**: a sidebar page that shows a message |

The repository is public, so nothing needs a GitHub token.

- **Join:** see [JOIN.md](JOIN.md). It's one command.
- **Groups:** the repository root is the **Home** group, which everyone gets.
  [`groups/lean-software-developers`](groups/lean-software-developers) and
  [`groups/lean-software-student`](groups/lean-software-student) are extra
  groups with the same layout (their own `packages.json`, `plugins/`, and
  `marketplace.json`). Each machine subscribes to any number of them
  (`bb hub group subscribe <id>`, or the selector at the top of the Plugin hub
  page). When a plugin id is in several subscribed groups, the newest version
  wins.
- **Browse in bb:** the repository is also a bb plugin marketplace,
  [`marketplace.json`](marketplace.json) ("Team plugins"). The hub adds it to
  **Settings → Plugin marketplaces** on every member's machine, so the plugins
  show up in bb's own plugin store. It's generated from `packages.json` and the
  plugin folders by `scripts/build-marketplace.mjs`, and a GitHub Action
  regenerates it on every push; don't edit it by hand.
- **Three kinds of plugins** every hub installs:
  - **Local plugins**: folders in `plugins/` of this repository.
  - **Remote plugins**: plugins in other **public** repositories. Nothing is
    copied; `packages.json` points to the repository and every hub installs it
    from there. Private repositories can't be used.
  - **Marketplace plugins**: entries from bb's marketplaces.
- **Add a plugin:** `bb hub plugin add <source>`, or the **Add a plugin** box on
  the Plugin hub page:
  - a public repo (`owner/name`, an https URL, or a GitHub folder link) becomes
    a **remote plugin**;
  - a folder or `.zip`/`.tar` (file, URL, or dropped on the page) is copied in
    as a **local plugin**.

  It pushes with the bb machine's own git login. If that login can't push to
  this repository, the Plugin hub page says so (and how to fix it) and greys
  out every button that would change the repository. You can also add a local
  plugin by uploading its folder into `plugins/` on GitHub, or with
  `scripts/add-plugin.sh <folder | .zip>`. `bb hub plugin remove <repo>` stops
  pointing to a remote plugin. Delete a local plugin's folder (or add it to
  `exclude`) to stop updating it, or delete it with the page's 🗑 button or
  `bb hub plugin delete <folder> --yes`, which also uninstalls it, with its
  data, from every member's bb.
- **Add a marketplace plugin for everyone:** `bb hub marketplace search <words>`,
  then `bb hub marketplace add <id>@<marketplace>` (or **Search** and **Add for
  everyone** on the Plugin hub page). `bb hub marketplace remove <id>` takes
  it off the list. Machines keep it installed but stop managing it.
- **Ship an update:** push to the plugin (its folder here, or its own
  repository for a remote plugin). Every running hub picks it up at the next
  shared sync (every 15 minutes, at `:00`, `:15`, `:30`, `:45` UTC). Only
  plugins whose folder changed are updated.

## Developing a plugin and releasing it when it's ready

Members only get what's in this repository (or the branch or tag it points
to). So develop somewhere else and publish when you choose.

### Option 1: develop locally, publish when it's stable

Best for team plugins that live in this repository.

1. **Develop on your own machine only.** Nobody else sees it.
   ```sh
   cd ~/code/my-plugin
   bb plugin install .     # registers the folder in place, on this machine only
   bb plugin dev           # rebuilds and reloads on every save
   ```
2. **Publish it** (the first release, and every one after it):
   ```sh
   bb hub plugin publish ~/code/my-plugin [--group <id>]
   ```
   Or use **Publish** under **Your local plugins** on the Plugin hub page
   (every plugin you run from your own folder is listed there; you can also
   start developing one there by entering its folder and clicking
   **Develop**, which is `bb hub dev <folder>`). The same controls are also one
   click away under the **Publish** button in the left sidebar's footer (next
   to Settings; it works with BB Sidebar too). It copies the
   folder into the group's `plugins/<name>` and pushes. It refuses unless
   `version` in `package.json` is newer than the published copy, and lists
   what changed. Every hub in the group gets it at the next sync (within 15
   minutes) and keeps the plugin's settings and data.
3. **Keep developing** in `~/code/my-plugin`. Your machine keeps running your
   folder (the hub leaves it alone); everyone else stays on the published copy.
   Bump the version and publish again when it's stable. To go back to the
   published copy on your machine, use the ✕ on its row or
   `bb hub dev stop <plugin-id>` (its settings and data stay).

### Betas: try a new version with a few people first

1. **Publish a beta:** `bb hub plugin publish ~/code/my-plugin --beta`, or
   **Publish beta** on the page. It goes to the group's `beta/<name>` folder,
   and its version must be newer than the stable copy.
2. **Testers join it:** `bb hub beta join <plugin-id>`, or **Join beta** under
   **Betas** on the page. `bb hub beta` lists the betas in your groups.
   Joining and leaving (`bb hub beta leave <plugin-id>`) switch the plugin
   between its copies **without a reinstall**: its settings and data stay.
   Everyone else stays on the stable copy.
3. **Make it the stable copy:** `bb hub plugin promote <plugin-id>`, or
   **Promote** on the page. Everyone gets it; testers move back to the stable
   copy, keeping their data.

How the switch keeps data: the hub installs the shared plugins from its own
checkout of this repository, so moving between copies only changes the folder
bb loads them from. One catch: a plugin that was installed before the hub did
this (from git) needs a one-time reinstall, which resets its settings and data,
the first time that machine joins its beta. The page asks first; on the CLI it
is `bb hub beta join <plugin-id> --reset-data`.

### Option 2: its own public repository, released by branch or tag

Best when the plugin is bigger or already has its own repository. Develop on
`main`, and point the group at a release instead of `main` with a `ref` on the
remote entry in `packages.json`:

- **A `stable` branch:** `"remote": [{ "repo": "you/bb-plugin-x", "ref": "stable" }]`.
  Releasing means merging `main` into `stable`. Adding a GitHub link such as
  `https://github.com/you/bb-plugin-x/tree/stable` sets the branch for you.
- **Version tags:** `"ref": "semver:^1.0.0"`. Releasing means tagging
  `v1.1.0`; hubs move up to the newest matching tag.

A followed repository (one with several plugins) works the same way: give its
`follow` entry a `ref`. Without one it follows the default branch, so every
commit to `main` reaches everyone.
