# Console probes

One-shot scripts for reading Discord's internals from DevTools. They are not part of the plugin —
they are how the bugs were found, kept so the findings can be re-verified when Discord changes.

Paste the contents of a probe into Discord's DevTools console (Sources/Console, Ctrl+Shift+I).
Each prints a report and copies it to the clipboard.

**First:** DevTools is disabled in Discord stable. Quit Discord completely from the tray, then:

```
node enable-devtools.js            # adds the flag to Discord's settings.json
node enable-devtools.js --disable  # put it back when finished
```

Quitting first matters: Discord rewrites `settings.json` as it exits and will overwrite the
change otherwise. The script refuses to run while Discord is open for that reason.

If the console will not let you paste, type `allow pasting` and press Enter — a Chromium
anti-scam guard. It is worth respecting generally: pasting console code from strangers is how
Discord tokens get stolen. Read these before running them; they print shapes, key names and
excerpts of Discord's own bundled code, never your token or messages.

| Probe | What it answers | Needs BetterDiscord |
|---|---|---|
| `discover.js` | What `DiscordNative` exposes; whether it is patchable; whether the webpack require cache is reachable | no |
| `discover2.js` | Whether `window.DiscordNative` itself can be shadowed; module source around a given id | no |
| `discover3.js` | Who builds the notification payload; how the renderer names IPC events | no |
| `discover5.js` | Whether the renderer's native bridge (`invoke`/`on`/`focus`) is patchable, and whether a second response listener receives clicks | yes |
| `discover6.js` | Where Discord's router lives | yes |
| `discover7.js` | Whether `getHistory().push()` actually navigates — **this one navigates your client** | yes |

`discover2.js` and `discover7.js` have `YOUR_GUILD_ID` / `YOUR_CHANNEL_ID` placeholders to fill
in first (Developer Mode → right-click → Copy Server ID / Copy Channel ID).

There is no `discover4.js`. The gap is real: that step was DevTools' own
**Search across all files** (Sources → Ctrl+Shift+F) for `fallbackDeepLink`, which found in one
search what three scripted probes had missed. See
[`../../docs/investigation.md`](../../docs/investigation.md) for why the scripts failed — the
short version is that pushing a chunk onto `webpackChunkdiscord_app` exposes a require cache with
only ~102 of 8352 modules instantiated, which is not enough to search.
