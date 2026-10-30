# Repository agent guide

This file governs the entire `dsh-google-chrome-use` repository.

## Project boundaries

- This is a DSH bundle: plain ESM in `src/`, with no build step. `src/client.js`, the page under Settings, is written directly in the form DSH expects of a client bundle. Do not add a build step unless that page outgrows this.
- The update on that page installs the exact version with the pnpm DSH uses, under the profile's own release-age policy. Never pass `--config.minimumReleaseAge`, never edit `minimumReleaseAgeExclude` from the plugin, and never install anything without the user clicking the button. A version forced past the policy makes pnpm refuse every later plugin install in that profile until it is old enough.
- The browser work belongs to the pinned `chrome-devtools-mcp` package. Do not fork it or reimplement its tools here. The plugin decides how to start it, when, and against which browser.
- Tools reach the model through `@deepseek-ai/dsh-mcp-client`. Do not write a second MCP bridge.
- Only `chrome_use` is registered at load. The browser tools must stay out of the tool list until it is called.
- All code must work on macOS and Windows. Never spawn through a shell, and never build a path with a hard-coded separator. `src/platform.js` takes the host as an argument so that both systems stay testable anywhere.

## Security requirements

- The dedicated profile stays the default target.
- Never launch or attach to the user's real profile without the user's own action in Chrome. Never automate Chrome's remote debugging checkbox or its Allow dialog.
- Keep chrome-devtools-mcp's usage statistics, update checks and CrUX lookups off. The plugin's own version check runs only when the user opens its settings page or asks for it.
- Do not pass `--allowUnrestrictedPaths` by default: it would let a page talk the model into uploading any local file.
- Changing what a browser can reach requires updating `SECURITY.md`.

## Validation

```sh
pnpm install
pnpm run check
node scripts/e2e-dsh.mjs
```

`pnpm run check` runs the unit tests and `scripts/smoke.mjs`, then packs a tarball into `.artifacts/`. Both scripts run Chrome headless in throwaway profiles and use no credentials. With `--headed` they open a real window instead, which is the plugin's default.

`scripts/e2e-dsh.mjs` runs the plugin inside a real DSH against a scripted model. Set `DSH_E2E_COMMAND` to a JSON array to choose the DSH, for example the CLI bundled in the desktop app. It cannot cover Chrome's Allow dialog or DSH's approval prompt. After changing the connection or approval flow, test those by hand in the Web UI with `target=my_chrome`. Its headless profile has no settings page either, so after changing the page or the update, test them by hand in the Web UI with a throwaway `DSH_HOME`.

Do not claim Windows support from a macOS run. The Windows evidence is the `Test (windows-latest)` and `windows-headed` jobs in `.github/workflows/ci.yml`. The second one uploads what was on the runner's screen. Neither covers a person using the desktop app.

## Upgrading chrome-devtools-mcp

Pin an exact version that is at least a few days old. Then run the validation above, because its tool names and flags change between releases. `src/session.js` names `new_page` and `navigate_page`, `src/guide.js` describes the workflow, and `src/server-args.js` passes flags that must still exist.

## Release authorization

`npm publish`, Git tags, GitHub releases and any Chrome Web Store submission are externally visible. Do them only when the user explicitly asks and confirms the version.
