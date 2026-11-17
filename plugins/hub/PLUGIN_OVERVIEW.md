Keep your team's bb plugins in one public repository, one folder per plugin,
and have every member's bb install and update them automatically.

## What you get

- **Packages**: the folders listed in `packages.json` are installed on every
  member's machine and updated when their folder changes.
- **One schedule**: every hub syncs at the same moments (every 15 minutes by
  default), and the page shows when a pushed change will have reached everyone.
- **Self-updating**: the hub updates itself the same way.
- A **Plugin hub** page in the sidebar, and a `bb hub` command with `list`,
  `install`, `adopt`, `packages`, `sync`, and `status`.

## How it works

bb installs each plugin straight from the public repository. The hub keeps a
small git mirror to read `packages.json` and to tell whether a plugin's own
folder changed, so a change to one plugin doesn't reload the others.

## Requirements

A public GitHub repository and `git` on the machine running bb. No tokens.
