# bb-plugin-server-badge

Shows which bb server a window is connected to, as a small badge in the
bottom-right corner (hover for host, user, port and app URL). Agents and
shells can run `bb server-badge` for the same information.

The label is the hostname of the server's `BB_APP_URL` (for example
`bb.example.com`), or `user@host:port` when it has none.

```sh
npm install --include=dev
bb plugin install . --yes
```
