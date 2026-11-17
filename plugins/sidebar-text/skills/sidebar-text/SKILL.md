---
name: sidebar-text
description: Change the message shown on the Sidebar text plugin's sidebar page. Use when the user asks to change, read, or reset that sidebar message.
---

# Sidebar text

The Sidebar text plugin adds a **Sidebar text** page to the left sidebar that
shows one message. The page updates live when the message changes.

```sh
bb plugin config sidebar-text                         # show the current message
bb plugin config sidebar-text set message "New text"  # change it
bb plugin config sidebar-text unset message           # back to the default
```
