# Chrome Use: a real Chrome for DeepSeek Harness

[中文](README.md)

Lets DSH models use Google Chrome on your computer: open pages, read them, click, fill forms, pick dropdown options, upload files, handle dialogs and take screenshots. Works on macOS and Windows. So far Windows has only run the automated tests in CI, not the desktop app on a real machine, so please report anything you find.

The browser work is done by Chrome's official [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp). This plugin connects it to DSH: it loads on demand, chooses which Chrome to reach, handles each system's paths, sets privacy defaults and asks before opening a new site.

## Two ways to use it

| | Dedicated Chrome (default) | My Chrome |
| --- | --- | --- |
| What it is | A separate Chrome profile that keeps its own logins | The Chrome you already use, with all your logins and tabs |
| Good for | Research, testing pages, accounts you choose to hand over | Tasks that need accounts you are already logged in to |
| Setup | None | Chrome 144 or later, one checkbox, a folder permission on macOS, and Allow when connecting |

Just say which one you want, and the model picks it:

```text
Open example.com in Chrome and tell me the page title
Use my own Chrome to check whether I have new GitHub notifications
```

No Chrome extension is needed, and there is nothing else to install.

## Install

You need [Google Chrome](https://www.google.com/chrome/) and the DeepSeek Harness desktop app (0.2.1 or a later 0.2.x).

1. Open **Plugins** in the desktop app, click **Add plugin**, and enter this under package name or address:

   ```text
   dsh-google-chrome-use@0.1.0
   ```

   Choose the official source and click **Install**. For 24 hours after a release, DSH's pnpm holds back new versions, so keep the version number.

2. **Quit and reopen** the desktop app. Reloading the page does not load a new host plugin.

3. Try it in a conversation: "Open example.com in Chrome and tell me the page title."

<details>
<summary>Command line and custom profiles</summary>

```bash
dsh plugin --profile web add dsh-google-chrome-use@0.1.0
```

Do not use this command on the `desktop` profile; use the Plugins page there. DSH 0.1.5's headless profile has no attachment store, so the model receives no screenshots there. Everything else works.

</details>

## Connecting the Chrome you use

The first time the model uses your Chrome, follow its prompts:

1. **macOS only:** in System Settings → Privacy & Security → Files & Folders, turn on Google Chrome under DeepSeek Harness (under your terminal app if you use the command line). Without this the plugin cannot read Chrome's folder, and macOS does not ask on its own.
2. The plugin opens `chrome://inspect/#remote-debugging` in Chrome. Tick **Allow remote debugging for this browser instance**, then tell the model to continue.
3. When the model starts, Chrome asks whether to allow the connection. Click **Allow**.
4. The first time the model opens a site, DSH asks you. DSH does not ask in full access mode.

Once connected, the model receives the titles and URLs of all your tabs each time it opens a page, and these go to the model service you configured. Read [SECURITY.md](SECURITY.md) (in Chinese) first.

## Configuration

The Plugins page has no settings form yet. Add a row to your profile's `cordis.patch.yml` (`~/.dsh/profiles/desktop/cordis.patch.yml` on desktop), then restart DSH:

```yaml
- id: chrome-use
  name: dsh-google-chrome-use
  config:
    userDataDir: /Volumes/External/chrome-profile
```

The row replaces the whole config, and anything left out takes its default.

| Key | Default | Purpose |
| --- | --- | --- |
| `defaultTarget` | `dedicated` | Which Chrome to use when the model does not say: `dedicated` or `my_chrome` |
| `allowMyChrome` | `true` | Whether connecting to your Chrome is allowed |
| `askBeforeNewSite` | `true` | Whether to ask the first time a site opens in your Chrome. Nobody can answer in a headless run, so new sites are refused; turn this off for unattended use |
| `headless` | `false` | Run the dedicated Chrome without a window |
| `userDataDir` | `chrome-use/chrome-profile` in the DSH data directory | The dedicated profile, which can reach hundreds of MB |
| `executablePath` | Found automatically | Set this if Chrome is somewhere unusual |
| `toolset` | `standard` | `standard` has 26 tools, `slim` has 3, and `full` adds performance, memory and emulation |
| `fileRoots` | `[]` | Directories for uploads and saved files, besides the system temp directory |
| `toolCallTimeoutSeconds` | `180` | Timeout of one action; the first one waits for you to click Allow |
| `extraArgs` | `[]` | Extra chrome-devtools-mcp arguments, such as `--blockedUrlPattern=*://*.bank.example/*` |

## Cost

Until `chrome_use` is called, the plugin adds one tool definition. After that, every session in this DSH process carries the browser tools: about 6,000 tokens per request with `standard`, usually cached. A snapshot of a large page can reach 10,000 to 20,000 tokens. Have the model call `chrome_use` with `action=stop` to disconnect when you no longer need it.

A model without image input cannot see screenshots, but it can still work from page snapshots.

## Troubleshooting

**The browser is already running:** another DSH window is using the dedicated profile. Close it or disconnect it there.

**The first action times out:** Chrome's Allow dialog was not answered. Click it and ask the model to try again.

**Several sessions at once:** sessions in one DSH process share one browser connection, and switching targets affects all of them.

**Edge and other browsers:** upstream only officially supports Google Chrome. You can try other Chromium browsers with `executablePath`, with no guarantee.

## Development

```bash
pnpm install
pnpm run check
node scripts/e2e-dsh.mjs
```

- `pnpm run check`: unit tests, plus a smoke test with real headless Chrome.
- `scripts/e2e-dsh.mjs`: the full flow inside a real DSH with a scripted model. It needs no account.
- Add `--headed` to `scripts/smoke.mjs` or `scripts/e2e-dsh.mjs` to use Chrome with a window, the plugin's default.

## Credits

All browser capabilities come from chrome-devtools-mcp by Google's Chrome DevTools team (Apache-2.0). This project is not affiliated with Google.

## License

MIT
