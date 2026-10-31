# Changelog

## Unreleased

- Releases now come from GitHub Actions with npm provenance, not from a developer's machine. A tag publishes only after every CI job passes on macOS and Windows.

## 0.2.0

- Settings → Chrome Use shows the running version. Opening the page asks npm for the latest one, and a newer version installs in one click with the pnpm DSH uses. The page then asks for a restart. Nothing installs in the background.
- An update pnpm cannot do yet says why: the release cooldown, an install source that has not synced, or one out of reach.
- The Windows job on GitHub Actions now also runs Chrome with a real window, the plugin's default, and uploads what was on the screen.
- The end-to-end check that Chrome closes with DSH now works: on macOS it could never fail, and on Windows it did not exist.

## 0.1.0

First version.

- `chrome_use` connects Chrome and adds the browser tools on the next step. Until then a session carries only that one tool.
- Two targets: a dedicated profile that keeps its logins, and the Chrome the user already runs (Chrome 144 or later), reached without an extension.
- A guided setup for the user's Chrome: opens `chrome://inspect/#remote-debugging`, reports what the user has to do, and explains the macOS folder permission.
- Opening a site for the first time in the user's Chrome goes through DSH's approval.
- Usage statistics, update checks and CrUX lookups are off, sensitive request headers are redacted, and file tools stay inside the system temp directory unless configured otherwise.
- Built on chrome-devtools-mcp 1.12.0.
