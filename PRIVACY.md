# ToolsEngine privacy

ToolsEngine runs locally under your OS account. ToolsEnabled receives no telemetry or usage records. Requested workspace files and tool results are visible to the connected assistant; Codex conversation handling is governed by your agreement with OpenAI. Do not request credential files or expose secrets: ToolsEngine does not reliably recognize or redact private data.

The Codex plugin starts --no-browser: it reads and writes files only within the chosen current project and can fetch requested public HTTP(S) pages. Web requests send the requested URL, network address and ToolsEngine user agent to the selected destination and its redirects; private/local-network destinations are refused by default. Installation uses GitHub and explicit npm setup uses registry.npmjs.org or your own configured registry. There is no hosted MCP endpoint or ToolsEngine login.

Requested project files persist until you remove them. Other explicit ToolsEngine modes can keep browser snapshots under artifacts/toolsengine (newest 64), and browser download/artifact quotas are 256 files/64 MiB/16 MiB each including at most 32 downloads. Dedicated browser profiles retain cookies and sign-ins until you delete their chosen folder. The no-browser Codex plugin starts no browser or desktop helper and creates no browser profile. Uninstalling leaves project files and any artifacts/profiles you created; delete those folders yourself when no session is using them. Codex keeps its own plugin cache and session records under its configuration, managed by Codex rather than this server.

MIT LICENSE governs this source; no separate hosted service terms or product account apply. The public website terms are not claimed to cover this plugin. Questions: support@toolsenabled.ai.
