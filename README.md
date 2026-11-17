# bb-plugins

Shared [bb](https://getbb.app) plugins, one per folder, plus the **hub** that
installs them and keeps them up to date on every member's machine.

| Folder | Plugin |
|---|---|
| [`plugins/hub`](plugins/hub) | **Hub**: installs the plugins listed in [`packages.json`](packages.json), updates them, and updates itself |
| [`plugins/hello`](plugins/hello) | **Hello**: an example todo list (`bb hello`) |
| [`plugins/sidebar-text`](plugins/sidebar-text) | **Sidebar text**: a sidebar page that shows a message |

The repository is public, so nothing needs a GitHub token.

- **Join:** see [JOIN.md](JOIN.md). It's one command.
- **Add a plugin:** create `plugins/<name>/` (`bb plugin new <name>` scaffolds
  one), add `{ "path": "plugins/<name>" }` to `packages.json`, and push.
- **Ship an update:** push changes to a plugin's folder. Every running hub
  picks them up at the next shared sync (every 15 minutes, at `:00`, `:15`,
  `:30`, `:45` UTC). Only plugins whose folder changed are updated.
