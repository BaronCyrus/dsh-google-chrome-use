# Changelog

## 0.1.0

First version.

- `chrome_use` connects Chrome and adds the browser tools on the next step. Until then a session carries only that one tool.
- Two targets: a dedicated profile that keeps its logins, and the Chrome the user already runs (Chrome 144 or later), reached without an extension.
- A guided setup for the user's Chrome: opens `chrome://inspect/#remote-debugging`, reports what the user has to do, and explains the macOS folder permission.
- Opening a site for the first time in the user's Chrome goes through DSH's approval.
- Usage statistics, update checks and CrUX lookups are off, sensitive request headers are redacted, and file tools stay inside the system temp directory unless configured otherwise.
- Built on chrome-devtools-mcp 1.12.0.
