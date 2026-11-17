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

  It pushes with the bb machine's own git login. You can also add a local
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
