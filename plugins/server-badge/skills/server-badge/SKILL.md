---
name: server-badge
description: Find out which bb server this thread is running on (its public hostname, box, user and port) and whether it is the Development or Production server.
---

# Server Badge

Run `bb server-badge` to print which bb server you are on: its environment
(Development, Production, or Local) and the reason, the public app hostname
(or `user@host:port` when the server has no app URL), then the box's hostname,
the server's Unix user, its loopback port, and its app URL.

The environment comes from the plugin's `environment` setting, then the
server's `BB_ENVIRONMENT` variable, then its Unix user and systemd service
name (`dev`, `development`, `staging`, or `test` as a word means
Development, otherwise Production). A server without an app URL is Local. It
never looks at the URL itself. Override it with
`bb plugin config server-badge set environment development|production|auto`.

The same information is shown in bb's UI as a small badge in the bottom-right
corner (red for Production, green for Development); hover it for details.
