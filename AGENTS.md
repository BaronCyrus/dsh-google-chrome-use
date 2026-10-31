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

Moving a profile from a `link:` install to npm needs one step between removing and installing: delete the symlink `pnpm remove` leaves in the profile's `node_modules`. With DSH's hoisted linker, the next `pnpm add` otherwise moves the link target's `node_modules` into the new package directory. To rehearse this, use a link target that has its own `node_modules`.

## Upgrading chrome-devtools-mcp

Pin an exact version that is at least a few days old. Then run the validation above, because its tool names and flags change between releases. `src/session.js` names `new_page` and `navigate_page`, `src/guide.js` describes the workflow, and `src/server-args.js` passes flags that must still exist.

## Release authorization

`npm publish`, Git tags, GitHub releases and any Chrome Web Store submission are externally visible. Do them only when the user explicitly asks and confirms the version. Never reuse, move or delete a published version or its tag. If one needs a correction, publish a new patch version.

## Releasing

Pushing a `v*` tag releases. `.github/workflows/publish.yml` checks the tag and its notes, runs every job in `ci.yml`, publishes to npm's `latest` with GitHub OIDC, then creates the GitHub Release from `docs/releases/v<version>.md` with the tarball it published. Do not run `npm publish` locally: a local publish has no provenance. The workflow packs without installing dependencies, so the package must keep having no build and no lifecycle scripts. Never add a setup-node `registry-url` or `NODE_AUTH_TOKEN` to it: npm treats either as token auth and skips OIDC.

A manual run (`gh workflow run publish.yml`) does everything else a tag does and asks npm whether it would accept the workflow. Its `trusted-publisher` job fails while no trusted publisher exists.

1. Update together: the `package.json` version, `CHANGELOG.md`, the version pinned in both READMEs, and `docs/releases/v<version>.md`. The notes are in Chinese. The first line is `# v<version>：<短标题>`, which becomes the release title. Then a one-sentence summary, bullets with bold labels, a `验证：…` paragraph that says what was and was not tested, and how to update.
2. Run the validation above, commit, push `main`, and wait for CI.
3. **Until npm has a trusted publisher for this package:** ask the user to add one in the package's settings on npmjs.com: repository `BaronCyrus/dsh-google-chrome-use`, workflow filename `publish.yml`, environment empty. Only the user can, with 2FA, so never ask for a token, password or one-time code. A new one expires unless a publish succeeds within 2 days, so ask only when the version is ready to tag. Then do a manual run and read its `trusted-publisher` job.
4. Tag and push:

   ```sh
   git tag -a v<version> -m "dsh-google-chrome-use v<version>"
   git push origin v<version>
   ```

5. Confirm the run succeeded, `npm view dsh-google-chrome-use dist-tags --prefer-online` shows the version as `latest`, `npm view dsh-google-chrome-use@<version> dist.attestations` is not empty, and `gh release view v<version>` shows the notes and the tarball. For the first release this way, suggest the user turn on "Require two-factor authentication and disallow tokens" under the package's publishing access.

If a CI job fails on a flake, re-run the failed jobs with `gh run rerun <id> --failed`. If `publish` fails on OIDC, fix the trusted publisher and re-run it the same way. If the tagged tree itself must change, publish a new patch version. If npm published but `release` failed, re-run that job. If it has to be done by hand, attach the tarball npm serves (`npm pack dsh-google-chrome-use@<version>`), and use `node scripts/release-notes.mjs <version> --body-file <path>` for the title and body.
