# bb-plugin-server-badge

Shows whether a window is connected to the **Development** or **Production**
bb server, as a small badge in the bottom-right corner. On a personal machine
(no public app URL) it shows `user:machine:port` instead. It never gets in the
way: clicks go straight through it, and it fades out while the mouse is near.
Run `bb server-badge` for the server's name, host, user, port, app URL, and why
it chose that environment.

## How the environment is decided

Never from the URL. In this order:

1. The plugin's **Environment** setting, if not Auto
   (`bb plugin config server-badge set environment production`).
2. The server's `BB_ENVIRONMENT` variable (`development`, `staging`,
   `production`, …). Set it in the server's systemd unit with
   `Environment=BB_ENVIRONMENT=production`.
3. The server's Unix user and its systemd service name: if either contains
   the word `dev`, `development`, `staging`, or `test` (for example user
   `bb-dev` or `ew-bb-server-dev.service`), it's **Development**; otherwise
   **Production**.
4. A bb with no public app URL (a personal machine) is **Local**.
