# Discord notification persistence (Windows)

Discord deletes its own notifications on Windows about five seconds after they appear. Step away
from your desk, come back, and there's nothing in the notification center telling you that you
missed anything.

This plugin stops that and fixes two other related annoyances:

- Notifications never tell you which server they came from
- Clicking an older notification just brings Discord to the front instead of opening the message

Windows only. These bugs don't exist on macOS or Linux.

---

> ### Heads up: this was built with AI
>
> Most of the code here, and most of the digging through Discord's internals, was done by Claude
> (Anthropic's Claude Code). I directed the work, tested every change against a real Discord
> client, and read what shipped. But I'm not going to pretend I typed it.
>
> That's also why it isn't in the BetterDiscord plugin store. Their
> [guidelines](https://docs.betterdiscord.app/plugins/publishing/guidelines) say you can't submit
> an automatically-generated plugin, which is a reasonable rule, and I'm not looking for a way
> around it. It lives here instead, for anyone who wants it.
>
> It doesn't do anything sketchy. No `child_process`, no access to your token or account details,
> no telemetry, no auto-updater, and it doesn't touch BetterDiscord's own files. It's one file,
> under 400 lines, with comments explaining why each patch exists. Worth a skim before you install
> it, honestly — that goes for any plugin.

---

## Install

1. Install [BetterDiscord](https://betterdiscord.app) if you don't have it.
2. [**Download NotificationPersistence.plugin.js**](https://github.com/jmjd/discord-notification-persistence/releases/latest/download/NotificationPersistence.plugin.js)
   and put it in `%APPDATA%\BetterDiscord\plugins`.
3. In Discord: User Settings → Plugins → turn on **NotificationPersistence**.

No restart needed.

If you'd rather read the file first, it's [here](plugin/NotificationPersistence.plugin.js) —
though use the download link above to save it, since saving from GitHub's code view gives you a
web page instead of the plugin.

Or, if you have the [BetterDiscord CLI](https://github.com/BetterDiscord/cli), one line does it:

```
bdcli plugins install https://github.com/jmjd/discord-notification-persistence/releases/latest/download/NotificationPersistence.plugin.js
```

### Updates

BetterDiscord only auto-updates plugins from its own store, so this one won't tell you when
there's a new version. If you'd like to know, hit **Watch → Custom → Releases** at the top of
this page. Otherwise just re-download now and then.

## Checking that it works

Wait for a notification, let it sit for a minute, then open the notification center (`Win+N`).
If it's still listed, it's working. Before, it would have been gone.

The title should also name your server rather than something like "Text Channels", and clicking
it should jump you to the message.

If your servers are quiet and you don't want to wait, `tools/test-notification.js` will trigger a
real notification on demand using a webhook. Instructions are at the top of that file.

## Settings

Found under the plugin in Discord's plugin list.

**Auto-clear window** (default 8000ms) — how long after a notification appears a removal still
counts as Discord's auto-clear timer. Discord's timer fires at about 5 seconds, so the default
leaves some headroom. Removals after this window are allowed through, which is what lets the
notification center still empty out normally for things you've read.

**Show the server name** — rewrites the title so it names the server.

**Open the message when clicked** — makes clicking an old notification actually go somewhere.

**Log to console** — prints what the plugin decides, notification by notification. Handy for
checking it still works after a Discord update.

## So why is this broken?

Short version: Discord's notification code was written for macOS, and the Windows path never got
finished.

**The disappearing act.** Discord sets a five-second timer and then closes each notification
itself. On macOS and in a browser, "close" means "hide the banner", so that's fine — it's just
how long the thing stays on screen. On Windows, the same call tells the OS to *revoke* the
notification, which wipes it from the notification center. Same line of code, completely
different outcome.

**The missing server name.** Discord does gather the server name, sender, and other details — but
that whole block sits inside an `if (isMac())`. Windows gets a title built from the channel's
*category* instead, which is why you see things like "Text Channels".

**The dead clicks.** Discord forgets which message a notification pointed at once the banner goes
away. It has a backup plan for this (a deep link it can fall back on), and it fills that field in
on Windows. But the Windows code path drops the value before it reaches the part that would use
it. So the backup never runs.

The thing I find genuinely interesting: none of this looks deliberate. Discord built the fields,
the fallback handler, and the notification-grouping support, then left each one disconnected on
Windows. It reads like a half-finished port, not a decision anyone made about Windows users.

If you want the actual code, with line-by-line detail and the measurements:
[`docs/root-cause.md`](docs/root-cause.md). How it was tracked down, including the wrong turns:
[`docs/investigation.md`](docs/investigation.md).

## Things to know before installing

Discord updates can break this. The plugin finds Discord's internals by shape, and a big enough
refactor will make it miss. When that happens it shows an error toast rather than failing quietly,
so you'll know, but you'd need an update from here. It's survived two Discord updates so far.

Using BetterDiscord at all is against Discord's terms of service, and so is this. Nobody seems to
get in trouble for local client mods, but it's your call to make with that in mind.

## Planned

- **A version that doesn't need BetterDiscord** ([#1](https://github.com/jmjd/discord-notification-persistence/issues/1)).
  There's a second implementation that patches Discord's own notification file directly and fixes
  all three bugs with no client mod at all. I use it myself. It isn't published yet because it
  currently replaces one of Discord's files wholesale, and I'd rather not host Discord's code —
  it needs reworking to wrap the original instead.
- **Nicer settings UI** ([#2](https://github.com/jmjd/discord-notification-persistence/issues/2)).
  Cosmetic. The current panel works, it just doesn't use Discord's native switches.

## Repo layout

```
plugin/          the plugin itself, plus its tests
tools/           webhook test script, and the console probes used to find all this
docs/            the detailed write-ups
```

## License

MIT. Do what you like with it.
