# ToolsEngine agent workflow

Use the capabilities offered by the active MCP connection and the user's task
authority. A status request is read-only unless the user also requests changes.

## Browser work and handoff

Where the selected browser mode supports it, work in its private hidden window
by default. Keep the same browser, profile, tabs and authenticated session.
Show that window with `browser.show` at the user's requested review or handoff
point, or when their direct interaction is necessary. Hide it again with
`browser.hide` when autonomous work resumes, unless they ask to keep it visible.
An explicit request to watch the work takes precedence over this default.
Check visibility rather than assuming that a browser mode supports handoff.
Do not replace an established browser with another profile just to hide it.

For an authorized credential handoff, prefer a supported opaque credential path.
The agent receives a handle; the sensitive value remains inside the local
helper and goes only to the intended origin and field. In standalone Firefox,
use `browser.capture_credential`, `browser.fill_credential` and
`browser.revoke_credential`. Capture from the authorized source without first
returning a plaintext source-page snapshot. Use a precise source label; never
assume a generic word uniquely identifies the credential. If a message needs
expansion, use `browser.find_control` with an already-known action name and
then the normal click tool, without exposing the message body. Never put a credential in chat,
ordinary tool arguments, command arguments, logs, screenshots, clipboard or
temporary files. Do not reveal a password to obtain an ordinary typing target.
The fill tool never submits: use a fresh page observation and the normal sign-in
control when submission is authorized. Read the precise privacy and lifetime
limits in [the Firefox instructions](docs/hidden-firefox.md).

Physical key touches and other user-presence checks still require the user.
Use the configured discreet cue when available; expose the relevant UI only
when needed for direct interaction. An opaque credential path does not remove
MFA, site controls, tool restrictions or browser sandboxing. Missing support in
one adapter is an implementation limitation, not evidence that the user denied
permission. Report the actual limitation without claiming an unrelated key
expired or that a sign-in succeeded.

The OpenAI plugin profile is separately scoped to files and public web with
`--no-browser`; these instructions do not enable browser or credential tools
through that profile. Discover current capabilities before choosing a path.

## Proper repairs and verification

Find the actual implementation and deployment that own the behavior. Preserve
the user's established architecture. Repair the intended integration and test
it end to end; do not substitute a temporary workaround or call a partial fix
complete. Distinguish input delivery, authenticated access, resource entitlement
and a successfully executed job. Never launch jobs, reserve compute resources,
or submit consequential actions outside the user's authorized scope.
