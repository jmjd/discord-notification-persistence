# Discord notification persistence (Windows)

Discord deletes its own Windows notifications about five seconds after they appear. If you were
away from your desk, there is nothing in the notification center to come back to. This fixes
that, and two related Windows-only problems: notifications that never name the server they came
from, and notifications that do nothing when you click them.

> **Written with AI assistance.** This plugin was developed with Claude (Anthropic's Claude
> Code) doing the bulk of the investigation and the writing. I directed the work, tested every
> change against a live client, and reviewed what shipped — but it would be dishonest to present
> it as hand-written.
>
> BetterDiscord's [plugin guidelines](https://docs.betterdiscord.app/plugins/publishing/guidelines)
> say: *"You may not submit an automatically-generated plugin (AI or otherwise)..."* — so this is
> **deliberately not submitted to the BetterDiscord plugin store**, and should not be. It is
> published here for anyone who wants it, to install manually and read before they do.
>
> It is clean on every other guideline: no `child_process`, no token/email/password access, no
> data collection, no remote or closed-source libraries, no minification, no self-updater, and
> it does not touch BetterDiscord's own files.

## Install

1. Install [BetterDiscord](https://betterdiscord.app).
2. Download [`plugin/NotificationPersistence.plugin.js`](plugin/NotificationPersistence.plugin.js)
   into `%APPDATA%\BetterDiscord\plugins`.
3. Discord → User Settings → Plugins → enable **NotificationPersistence**.

No restart needed. See [`plugin/README.md`](plugin/README.md) for settings and how to verify it
is working.

## What is actually wrong

Three separate bugs, all specific to Windows, all visible in Discord's own code. Full detail
with excerpts in [`docs/root-cause.md`](docs/root-cause.md).

**1. Every notification is destroyed five seconds after it is shown.**

```js
G && setTimeout(() => e.close(), 5e3)
```

On Windows that `close()` reaches WinRT `ToastNotifier.Hide()`, which does not merely dismiss the
on-screen banner — it deletes the toast from the notification center. The same line is correct
on other platforms, and correct in a browser, where `close()` just hides a banner. Measured at
4995–5009ms across runs, with no OS event involved.

**2. The server name is never sent.** Discord's metadata enrichment is wrapped in
`if (isMac())`, so on Windows `groupName`, `senderDisplayName` and `threadIdentifier` are all
absent. The title you get is `Sender (#channel, Category)` — the channel's *category*, not the
server.

**3. Clicking a notification does nothing** once the banner has gone. Discord drops its record
of a notification when the banner is dismissed, then falls back to a deep link — but the deep
link never arrives, because the Windows callback drops that argument before sending it:

```js
lib.setCallbacks((action, identifier, userText, fallbackDeepLink) => send(..., fallbackDeepLink), ...)
lib.setCallbacks((action, identifier, userText)                  => send(...))   // the Windows one
```

Confirmed live: the response arrives with four arguments, never five.

None of this looks like a decision about Windows. Discord built `fallbackDeepLink`, the toast
header support and the deep-link fallback handler, and then left each one starved of its input
on Windows. It reads like a port that was never finished — the native notification module was
added because *macOS* needed one, and Windows got an adapter so the shared code would not fork.

## How it is fixed

| Bug | Fix |
|---|---|
| Five-second destruction | Refuse a `close()` arriving within 8s of display with no click from you. Later removals are honoured, so the notification center still empties for things you have read. |
| Missing server name | Look the guild up in Discord's own store and rewrite the title in place: `(#general, My Server)` instead of `(#general, Text Channels)`. |
| Dead clicks | Keep the identifier→deep-link association Discord discards, notice the dismissal that makes Discord forget, and navigate there yourself when such a notification is clicked. |

## Repository layout

```
plugin/          the BetterDiscord plugin, and its tests
tools/probes/    the console scripts used to find all of this, kept so anyone can re-verify
docs/            root cause with code excerpts, and how it was investigated
```

## Planned

- **A second implementation, needing no client mod** ([#1](https://github.com/jmjd/discord-notification-persistence/issues/1)) — a patch to Discord's own `notifications_win.js` that fixes the same three bugs from the main process. It works and is in daily use, but it currently *replaces* that file, which would mean redistributing Discord's code. It needs restructuring to wrap the original instead, after which it will land in `patch/`. Its update watcher has survived two real Discord updates unattended.
- **Native settings controls** ([#2](https://github.com/jmjd/discord-notification-persistence/issues/2)) — swap the hand-rolled settings panel for `BdApi.UI.buildSettingsPanel`. Cosmetic.

## Caveats

- **Windows only.** macOS and Linux do not have these bugs.
- Patching the client is against Discord's terms of service, in the same way BetterDiscord
  itself is. Enforcement against local client mods is effectively unheard of, but that is your
  call to make knowingly.
- The plugin finds Discord's internals by shape, so a Discord refactor can break it. It fails
  with a visible error toast rather than silently, but you would need an update.

## License

MIT — see [LICENSE](LICENSE).
