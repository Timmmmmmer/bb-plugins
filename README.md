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
- **Add a plugin:** put its folder in `plugins/<name>/`. That's it: every
  folder there that holds a bb plugin is installed on every hub. Any of these
  works:
  - **From bb:** `bb hub plugin add <git URL | folder | .zip/.tar file or URL>`,
    or the **Add a plugin** card on the Plugin hub page (paste a source, or
    upload a folder or `.zip`). It pushes with the bb machine's own git login.
  - **In the browser:** on GitHub, open `plugins/`, choose **Add file → Upload
    files**, and drag in the plugin's folder (without `node_modules`).
  - **From any source** (local folder, git repository, or `.zip`/`.tar.gz`):
    ```sh
    scripts/add-plugin.sh ~/code/my-plugin
    scripts/add-plugin.sh https://github.com/someone/bb-plugin-weather
    scripts/add-plugin.sh https://example.com/plugin.zip --subdir plugin
    ```
    It copies the plugin in (without `node_modules`, `dist`, `.git`, `.env`),
    checks the manifest, commits, and pushes. `--help` lists the options.

  To keep a folder in the repository without installing it everywhere, add it
  to `exclude` in `packages.json`.
- **Ship an update:** push changes to a plugin's folder. Every running hub
  picks them up at the next shared sync (every 15 minutes, at `:00`, `:15`,
  `:30`, `:45` UTC). Only plugins whose folder changed are updated.
