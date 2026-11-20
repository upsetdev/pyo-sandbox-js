# Changelog

## 0.5.0

### 🚀 Features

- [6ea7c19](https://github.com/upsetdev/pyo-sandbox-js/commit/6ea7c19) feat: start sandboxes from base when no template is given
- [164f1e4](https://github.com/upsetdev/pyo-sandbox-js/commit/164f1e4) feat: create a sandbox on a server you pick
- [a00aceb](https://github.com/upsetdev/pyo-sandbox-js/commit/a00aceb) feat: take lifetimes up to 365 days and none
- [7de027b](https://github.com/upsetdev/pyo-sandbox-js/commit/7de027b) feat: name sandboxes and rename them
- [baf7ce2](https://github.com/upsetdev/pyo-sandbox-js/commit/baf7ce2) feat: list sandbox servers with their runtime
- [81a0c7d](https://github.com/upsetdev/pyo-sandbox-js/commit/81a0c7d) feat: close a sandbox port
- [37a4a07](https://github.com/upsetdev/pyo-sandbox-js/commit/37a4a07) feat: search sandboxes by name or id
- [3abfdc5](https://github.com/upsetdev/pyo-sandbox-js/commit/3abfdc5) feat: open sandbox web pages and the desktop over https on the tailnet

### 📝 Docs

- [e834287](https://github.com/upsetdev/pyo-sandbox-js/commit/e834287) docs: say base is Ubuntu 24.04
- [4c6a2ff](https://github.com/upsetdev/pyo-sandbox-js/commit/4c6a2ff) docs: show pyo cloud's address and leave the old key name out

### ⚠️ Breaking Changes

- `SandboxInfo.expiresAt` is null for a sandbox that runs until it's deleted (`ttl: "none"`). Code that reads it as a number needs a check.

## 0.4.0

The first release: create sandboxes, run commands, use terminals and files, open and reach ports, and ready-made tools for the Claude API and the Vercel AI SDK.
