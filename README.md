# Trace

Trace is a desktop app for running **Claude Code and OpenAI Codex side by side**. Each channel is the real CLI in a real terminal. Around those channels Trace adds a few things:

- Git change review.
- Usage and cost tracking.
- Shared rules and memory for both agents.
- Sync between your computers.
- A phone page for answering prompts when you're away from the desk.

Your Claude and Codex sign-ins stay with their own CLIs. Trace never sees your credentials.

## Install

Download from the **[downloads page](https://github.com/KGeary1995/trace-releases/releases/latest)**.

| Computer | File | First launch |
|---|---|---|
| Windows | `Trace-<version>-Windows-x64-Setup.exe` | Windows may say it doesn't recognize the app (the installer isn't code-signed yet). Choose **More info → Run anyway**. |
| Mac with Apple silicon (M1 and later) | `Trace-<version>-macOS-arm64.dmg` | Drag the app to Applications. macOS blocks the first launch because the app isn't notarized by Apple. Open **System Settings → Privacy & Security** and click **Open Anyway**. |
| Intel Mac | `Trace-<version>-macOS-x64.dmg` | Same as above. |

**Upgrading from a version called AI Coding Hub:** on Windows, the Trace installer replaces it. On a Mac, Trace.app installs beside the old AI Coding Hub.app, and Trace offers once to move the old copy to the Trash. Your settings, channels and history carry over either way.

Not sure which Mac you have? Apple menu → **About This Mac**: "Chip: Apple M…" means arm64, "Processor: Intel" means x64.

**Updates:**
- **Windows:** the installed app checks for new versions. Download and install them in **Settings → Application updates**.
- **Mac:** download each new version from the downloads page. **Settings → Application updates → Open downloads page** takes you there.

Your settings, history, rules and memory live in `~/.coding-hub` and carry over between versions.

## Before you start: install the CLIs

Trace runs the official CLIs; it does not install them. In a normal terminal:

1. Install **[Claude Code](https://code.claude.com/docs)** and **[Codex](https://github.com/openai/codex)**.
2. Run `claude` and `codex` once each and sign in.
3. Check that `claude --version` and `codex --version` work.

If a channel says a CLI was not found, install it (or fix your PATH), then restart Trace.

## First steps

1. **Connect accounts.** Open **Agent setup → Accounts & connections**. Trace detects existing sign-ins; **Connect** runs the CLI's own login if needed.
2. **Open a project.** Click **Open project** and pick the folder you want the agents to work in.
3. **Start channels.** The workspace opens with a Claude Code channel (CH1) and a Codex channel (CH2). Press **Start session** on each. Click into a terminal to type.
4. **Add more.** **+ Channel** adds up to eight channels. Each channel runs its own CLI, so more channels use more memory. Choose **Terminal** for a plain shell (zsh or bash on a Mac, PowerShell on Windows) in the project folder, for running tests or Git yourself.
5. **Paste images.** Paste a screenshot into a Claude Code or Codex channel with Ctrl+V or Cmd+V, or drop an image file on it. A thumbnail appears under the terminal; click it to see it full size.
6. **Review changes.** The **Changes** tab shows every file the agents changed.

Getting around:
- **Ctrl+Shift+P** (Cmd+Shift+P on Mac) opens the command menu.
- **Alt+1–8** jumps to a channel.
- **G** then a letter opens a view (U Usage, C Changes, S Settings…).

### Where things are

| Menu | What's in it |
|---|---|
| Tabs | **Workspace** (the channels), **Changes** (Git review), **Projects** |
| **Insight** | Usage, Session history, Files, and **More tools** (Design workspace, AI coaching, Task coordination, Verification profiles) |
| **Agent setup** | Accounts & connections, Shared memory, Shared rules, MCP servers, Skills & plugins, Settings, Workflow center |

## Use Trace from your phone

You can read and type into running channels, answer approval prompts, and get an alert when a channel needs you. Phone access is off until you turn it on in **Settings → Phone access**.

1. Install **[Tailscale](https://tailscale.com/download)** on the computer and the phone, signed in to the same account. Tailscale is a private network between your own devices; nothing is opened to the internet.
2. Click **Set up Tailscale HTTPS**. If Tailscale needs HTTPS certificates turned on first, Trace shows the steps and opens the right Tailscale page. When you come back, it finishes setup by itself.
3. Click **Pair a phone** and scan the QR code with the phone's camera.
4. On the phone, add the page to the Home Screen so it opens like an app. Then turn on **alerts** under the channel list.

A paired phone can read and type into running channels and nothing else. Remove phones you no longer use from the same card.

## Use Trace on more than one computer

**Sync:** turn on **Settings → Sync settings, rules, templates and usage between computers** on each computer, and point every computer at the same Google Drive folder.

**See and control one computer's channels from another:**
1. On each computer, turn on sync (same Drive folder) and **Phone access** with Tailscale HTTPS.
2. Within a minute, each appears on the other under **Settings → Other computers**.
3. On the computer you want to reach, click **Show link code**. On the other, type that code next to its name and click **Link**.

The linked computer gets its own tab next to **Projects**, showing its channels live: type into them, answer prompts, and **Start**, **Stop**, **Restart** or **Interrupt** them. Link in both directions to do the same the other way. Running sessions and sign-ins stay on the computer that runs them.

**One phone app for every computer:** pair your phone with one computer. Its channel list then shows every linked computer's channels too, with a switcher to show one computer at a time. If that computer is off, the app still opens and connects straight to your other computer, and switches back by itself. Alerts come from the computer you added the app from.

## Troubleshooting

| Problem | What to do |
|---|---|
| A channel shows **FAULT: The terminal process could not start** | The message names the cause. If you run Trace from source, run `npm run rebuild:native`. Check that the CLI runs in a normal terminal. |
| A channel says the CLI was not found | Install the CLI, run it once in a terminal to sign in, then restart Trace. |
| Codex exits right away | **Workflow center → Recovery** runs checks. **Use Codex CLI defaults** clears model settings that the CLI rejected. |
| Tailscale HTTPS setup fails | Follow the steps shown on the Phone access card. On Windows, an "access denied" error means you should run Trace once as administrator. |
| Windows Defender removed the installer | Download it again and check the file in Defender's **Protection history**. The installer is not code-signed yet. |

## Run from source

You need Node.js 22.13 or later and Git.

```sh
npm ci
npm start        # builds and opens the app
npm run dev      # development mode with reload
```

On Windows, use `npm.cmd` in PowerShell. Run these commands inside the project folder, the one with `package.json`.

**Checks:**
- `npm run typecheck`
- `npm test`
- `npm run test:desktop` and the other `test:*` scripts, which are end-to-end smoke tests with fixture CLIs.

**Releases:** pushing a `v<version>` tag builds the Windows installer and the Mac disk images, and publishes them on the downloads page. See [releases](docs/windows-releases.md).

**Signed Mac builds:** set `MAC_SIGNING_IDENTITY` to your Developer ID Application name (for example `"Kyle Geary (73DB29GHV2)"`) before `npm run dist:mac` to sign with the hardened runtime. To notarize as well, store credentials once with `xcrun notarytool store-credentials trace-notary --apple-id <your Apple ID> --team-id 73DB29GHV2` and set `APPLE_KEYCHAIN_PROFILE=trace-notary`. The build then checks that Gatekeeper accepts the app, so it opens without **Open Anyway**. Notarize each signed disk image too before publishing: `xcrun notarytool submit <dmg> --keychain-profile trace-notary --wait`, then `xcrun stapler staple <dmg>`.

## More

- [Reference](docs/reference.md): how each part works, what is stored where, and the release history.
- [Architecture](docs/architecture.md).
- [Releases and signing](docs/windows-releases.md).
