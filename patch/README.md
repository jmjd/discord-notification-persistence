# The patch (no BetterDiscord required)

Fixes the same three notification bugs as the plugin, but in Discord's own process instead of
through a client mod. Use this if you don't want BetterDiscord, or want something that keeps
working when BetterDiscord breaks on a Discord update.

Root cause for all three bugs, with Discord's code: [`../docs/root-cause.md`](../docs/root-cause.md).

## What it actually does

Discord loads its Windows notification code from a plain JavaScript file on disk:

```
%LOCALAPPDATA%\Discord\app-<version>\modules\discord_notifications-1\discord_notifications\notifications_win.js
```

This moves Discord's file aside to `notifications_win.stock.js` and installs a wrapper in its
place. The wrapper **delegates everything** to Discord's own file and overrides only three
behaviours. It is not a modified copy of Discord's module, and this repository contains no Discord
code.

That matters beyond licensing: because the wrapper only depends on the six functions Discord's
module exports, Discord can change *how* it builds notifications without breaking anything here.
`patch.js` checks those six exports still exist before installing, and refuses rather than
installing something non-functional.

## Install

Needs [Node.js](https://nodejs.org).

```
node patch.js apply      # then fully quit Discord from the tray and reopen it
node patch.js status     # PATCHED / OLD PATCH / stock, per installed build
node patch.js check      # is each of the three bugs still present?
node patch.js revert     # puts Discord's own file back
```

`config.json` and `servers.json` are created on first apply. Both are re-read while Discord runs,
so settings take effect without a restart — only changes to the wrapper's own code need one.

### Has Discord fixed it yet?

```
node patch.js check
```

Checks for the specific cause of each bug rather than diffing files, because "this file's hash
changed" is a chore while "the 3-argument callback is still there" is an answer:

```
Discord 1.0.9260 -- is each bug still present?

  STILL BROKEN  the 5s auto-clear timer
                last refused 2026-10-05T21:52:43.725Z at 5026ms after send
  STILL BROKEN  the server name (Windows toast headers)
                supportsHeaders() still returns false
  STILL BROKEN  the dropped fallbackDeepLink
                the 3-argument callback is still there
```

Only two of those are visible on disk. The 5s timer and the `isMac()` gate live in Discord's
renderer bundle, which is fetched from their CDN at runtime and never written to a file — so the
first line is inferred from this patch's own log, which is the only record of that timer's
behaviour. `tools/probes/` checks the renderer directly.

Each `apply` also archives Discord's own module under `stock-history/` (about 8 KB per distinct
version) and says so if the content has changed since the last build, so a change can be diffed
rather than guessed at. That directory is gitignored: keeping a local copy is useful, committing
Discord's code is the thing this implementation exists to avoid.

Costs, measured: 0.05 ms to hash the module, 0.14 ms to scan `core.asar` for the callback — once
per Discord update, in the short-lived patcher process. The resident watcher is unchanged.

### Surviving Discord updates

A Discord update installs a whole new `app-<version>` folder, so the patch needs re-applying. The
watcher does that the moment a new build is staged, which is *before* Discord restarts into it —
so Discord never comes up unpatched:

```
powershell -ExecutionPolicy Bypass -File install-watcher.ps1
powershell -ExecutionPolicy Bypass -File install-watcher.ps1 -Uninstall
```

It runs resident (~45 MB) and starts at logon. It prefers a scheduled task but falls back to a
Startup folder shortcut, because an at-logon scheduled task requires administrator rights.

There is no polling alternative on purpose. A scheduled task that re-checks hourly sounds lighter,
but it needs elevation to register at all, and it would leave you running unpatched until both the
next check *and* the next Discord restart. If you'd rather not have a resident process, skip the
watcher entirely and run `node patch.js apply` yourself after an update — `status` tells you when
it's needed.

## Settings

`config.json`, validated on every read. Anything unrecognised falls back to the default for that
key rather than being used, because a typo here would otherwise switch the fix off silently.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `fix` | `fix` refuses the auto-clear; `observe` passes everything through, leaving the module loaded but inert. Useful for turning the patch off without reverting it. |
| `timerWindowMs` | `8000` | A removal arriving within this long of sending, with no click, is Discord's auto-clear timer (measured ~5000ms) and is refused. Later removals are honoured, so the notification center still empties for things you've read. |
| `graceMs` | `20000` | Fallback rule for builds that report an OS dismissal before the removal. |
| `serverName` | `replace` | `replace` rewrites Discord's title, swapping the channel category for the server name. `title` appends it instead. `off` leaves titles alone. |
| `reviveClicks` | `true` | Make a click on a notification Discord has forgotten open the message. |
| `clickMode` | `ipc` | `ipc` hands the renderer the deep link `core.asar` drops, so Discord navigates natively. `protocol` goes out through the `discord://` handler instead — slower, but a useful fallback. |
| `discoverServers` | `true` | Read server names off Discord's sidebar ~25s after startup to fill in `servers.json`. |
| `log` | `true` | Append notification events to `events.log`. Message text is never logged, only lengths. |
| `maxTracked` | `300` | How many notifications to remember for the click fix. |

`servers.json` maps guild ids to server names. It fills itself in from Discord's sidebar; ids seen
for the first time are appended with an empty name and a `_hint_` showing the notification title
they came from, so you can label anything the scrape misses. `clean-servers.js` repairs names that
an older scrape recorded with unread decorations ("6 mentions, My Server").

### Difference from the plugin

The plugin offers two extra `serverName` modes — `attribution` (a small source line under the
message) and `header` (Windows groups the notification center by server). Neither is possible
here: the toast XML is built inside Discord's module, and the wrapper deliberately doesn't reach
into it. Only the title can be changed, which is what `replace` and `title` do.

## Upgrading from the earlier version

An earlier version of this patch replaced Discord's module with a full copy of it. `apply`
recognises that and migrates cleanly, keeping Discord's genuine original:

```
replacing the older full-copy patch, keeping its stock backup
```

This matters: that copy must never be mistaken for a stock file and backed up over the real one,
or the wrapper would delegate to it and apply every change twice.

## Tests

```
node test.js
```

44 checks, and **no Discord install needed** — the wrapper only talks to Discord through six
functions, so a recording stand-in in a temp directory covers every decision it makes.

Three of these were rewritten after a review found they couldn't fail (one compared a constant to
its own definition). The suite is now verified by mutation: breaking the wrapper in a specific way
produces a failure in the test named for it, including one check that exists purely to prove the
config validation is wired into the load path rather than merely present.

## This or the plugin?

Run **one** of them. If you run both, the plugin refuses the removal first and this never sees it —
harmless, but confusing to debug. Setting `mode` to `observe` keeps this installed and inert as a
fallback, which is one config edit away from taking over if BetterDiscord breaks.

| | this patch | the plugin |
|---|---|---|
| Needs | Node, to install | BetterDiscord |
| Survives a Discord update | needs the watcher | BetterDiscord re-injects |
| Survives BetterDiscord breaking | unaffected | inert until it's fixed |
| Server names from | Discord's sidebar, cached in `servers.json` | `GuildStore` directly |
| Fully reversible | yes — `revert` restores Discord's file | all but one event listener |
| Sharing | this folder plus Node | one file |

## Limitations

- **Windows only.** These bugs don't exist on macOS or Linux.
- Patching Discord's files is against its terms of service, the same way BetterDiscord is.
- If Discord stops exporting one of the six functions this overrides, `apply` refuses and says
  which — so it fails loudly, but you'd need an update.
