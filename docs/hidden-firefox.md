# Private Firefox on Linux

`--firefox-hidden` (also accepted as `--firefox-desktop`) adds Firefox UI tools
using a dedicated profile and an owned Xvfb display. It leaves the person's
visible Firefox alone. The default Chromium modes and no-browser Codex plugin
are unchanged.

Run the source entry with an absolute workspace outside the program folder:

```sh
node /absolute/toolsengine/bin/toolsengine.js --workspace /absolute/project --firefox-hidden
```

This optional mode requires Linux, a local desktop accessibility session,
Python 3 with PyGObject/AT-SPI, Firefox, Xvfb, xauth and xdotool. These are system
dependencies; the npm package does not bundle a browser or install them. The
existing installer does not configure this optional mode; use the explicit
entry command above in the client's MCP configuration.

The display is authenticated with a private Xauthority file. Reuse requires a
matching live Xvfb process, account, process start time and profile-specific
authorization file. An unrelated X socket is never adopted. No TCP listener is
started, and no virtual-machine fallback is claimed. Failure to establish the
private display is reported without moving input to the visible screen.

`browser.show` opens a window on the person's screen that shows this private
display live, where they can watch and use the hidden Firefox (for example to
sign in), and `browser.hide` closes it; Firefox is not restarted or reloaded.
`browser.visibility` says whether it is shown. These need TigerVNC's scraping
server and viewer; see [showing the hidden browser](browser-show-hide.md).
The other Firefox tools never use the visible screen, shown or not.

Firefox's content sandbox remains enabled. On Ubuntu, launching the installed
snap-mounted Firefox binary requires the already-installed `firefox` AppArmor
profile to permit its user namespaces. The helper uses that existing profile
for this browser process; it does not change global AppArmor settings or disable
the browser sandbox. If that launch is unavailable, it reports an error. The
helper stays in the caller's execution context and does not use `systemd-run`
to leave an enclosing sandbox.

The profile is private to the current account at
`~/.local/share/toolsengine/agent-firefox`. Creating it does not read the
person's everyday Firefox profile. The standalone MCP offers
`browser.transfer_firefox_profile` only for an explicit user request. It copies
saved logins, their key databases and cookies locally into this dedicated
profile, replacing its previous login state. The destination Firefox must be
closed. A stale lock file alone is accepted, while a live destination lock or
owned Firefox process refuses replacement. Source files remain unchanged; live
SQLite database/WAL pairs are copied to private staging and checked before use.
The result contains filenames and status, never credential values. Copied
credentials persist locally until removed with the dedicated profile. An
interrupted replacement can leave private recovery files in that profile.

Fleet setting `browser.agent_firefox_profile_transfer` set to `false` disables
transfer before source access; absent settings leave explicit transfer available.
Starting or observing the hidden browser never imports a source profile.

The OpenAI/Codex plugin entry always selects `--no-browser`: it offers only the
eight workspace/public-web/status/discovery tools and cannot dispatch profile
transfer. Standalone MCP capability does not imply directory approval of that
capability. For plugin authentication prefer the service's supported integration
or a user-approved browser flow outside this plugin entry.

Page observations and screenshots are returned to the client. This mode does
not automatically save page snapshots in the workspace. Password controls are
omitted, but pages can expose other secrets and personal data; redaction is not
guaranteed. The client must enforce the task's authority and human approval.
Firefox keeps its own downloads and profile data, and the Chromium mode's
workspace artifact/download quotas do not apply to this separate mode.

The UI tools preserve uncertain-action results so callers can inspect the page
before retrying a submit. References expire after 90 seconds and after actions.
File uploads require explicitly named, normalized absolute regular-file paths;
hidden components, links and junctions are refused.

Sign-ins made in the dedicated profile can persist between sessions. Stopping
the MCP connection detaches its helper; it preserves that profile and its
owned browser for a later connection. To retire it, close the owned browser and
remove the dedicated profile only after confirming it holds no work you need.
Uninstall does not delete profile data. These details are also covered in
[the privacy notice](../PRIVACY.md).

For an opt-in live check against a local fixture, with no real accounts:

```sh
TOOLSENGINE_FIREFOX_LIVE=1 node --test tests/firefox-live.linux.test.js
python3 tests/firefox_native_test.py
```

These checks do not qualify Windows or claim approval by a plugin directory.
The Linux release gate requires this live Firefox success as well as its
existing Chromium checks; leaving the opt-in check skipped refuses a release.
