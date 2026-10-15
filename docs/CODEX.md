# Codex plugin (unreleased branch)

Requires Node.js 22.14+ and a local Codex CLI with plugin support. This self-distributed stdio plugin is not a public-directory listing or OpenAI approval. The compatibility manifest explicitly declares empty hooks; no Claude hooks are required.

```sh
codex plugin marketplace add ToolsEnabled/toolsengine --ref openai-plugin
codex plugin add toolsengine@toolsengine
codex plugin list --json
```

The install result identifies the cached plugin folder. Review its `package.json` and `npm-shrinkwrap.json`, then, from that folder, run:

```sh
npm ci --omit=dev --ignore-scripts
```

This explicit setup downloads pinned dependencies from registry.npmjs.org (or your configured npm registry). Startup itself never installs or downloads anything and names missing setup. No browser download or system-wide install is performed. Re-run this setup after updating/reinstalling the plugin cache; do not run it in an unrelated project. Before starting Codex, explicitly select an existing project outside the plugin folder: in a POSIX shell from that project use `export TOOLSENGINE_CODEX_WORKSPACE="$PWD"`; in PowerShell use `$env:TOOLSENGINE_CODEX_WORKSPACE = (Get-Location).Path`. Restart Codex with this environment. Missing or relative selection is refused. The selected folder becomes the server workspace; all existing physical path and traversal checks apply. A project containing the installed plugin, or inside it, is refused.

Ask: “Use ToolsEngine system.status, write plugin-check.txt with the text hello in this project, then read it back.” Expect browserEnabled false, a successful write and exactly hello. This plugin offers the eight file/public-web/status/discovery tools of --no-browser. Browser/desktop integration remains available through the separate explicit MCP configuration in [clients.md](clients.md); it is not qualified by this plugin check. Do not install this plugin and a duplicate manually registered ToolsEngine server in the same session unless you deliberately want both.

The server runs with your OS account permissions; its workspace file boundary is enforced by the server, and approvals/task authority remain with Codex and the person. No product account, OAuth service, API key or paid model API is required. Codex authentication is separate. See [privacy](../PRIVACY.md) for data, retention and deletion. Uninstall using `codex plugin remove toolsengine@toolsengine`; project files and artifacts remain until you delete them. This branch has Linux qualification only; Windows qualification remains with the Windows release lead.
