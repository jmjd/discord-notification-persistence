# NotificationPersistence

A BetterDiscord plugin that fixes three Windows-only problems with Discord's notifications.
Root cause, with Discord's own code: [`../docs/root-cause.md`](../docs/root-cause.md).

## Install

1. Install [BetterDiscord](https://betterdiscord.app) if you have not already.
2. Put `NotificationPersistence.plugin.js` in `%APPDATA%\BetterDiscord\plugins`.
3. Discord → User Settings → Plugins → enable **NotificationPersistence**.

No Discord restart needed. From a clone, `node install-plugin.js` copies it for you — useful
when editing, since BetterDiscord hot-reloads on file change.

## What changes

**Notifications stay in the notification center.** Discord destroys each one five seconds after
showing it; the plugin refuses that specific removal. Removals that are *not* the auto-clear
timer are still honoured, so the notification center empties normally for things you clicked or
have since read — it does not become an ever-growing pile.

**The title names the server.** Discord sends Windows a title like
`Sender (#general, Text Channels)`, where the second part is the channel's *category*. The plugin
rewrites it to `Sender (#general, My Server)`, reading the real name from Discord's own guild
store. Direct messages are left alone.

**Clicking opens the message.** Once the banner is gone, Discord has forgotten what the
notification pointed at, so clicking it only brings the window to the front. The plugin remembers
and navigates.

## Settings

Plugin settings, in Discord's plugin list:

| Setting | Default | What it does |
|---|---|---|
| Auto-clear window (ms) | 8000 | A removal arriving within this long after display, with no click from you, is treated as the auto-clear timer and refused. Discord's timer measures ~5000ms; the margin absorbs a loaded machine. Later removals are honoured. |
| Show the server name | on | The title rewrite. |
| Open the message when clicked | on | Click navigation for notifications Discord has forgotten. |
| Log to console | off | Logs each refusal, retitle and navigation. Useful for checking it still works after a Discord update. |

## Verifying it works

The honest test needs a real notification, from someone else, while you are not looking at that
channel. If your servers are quiet, `../tools/test-notification.js` triggers one on demand through
a webhook you create — see the comment at the top of that file.

Then check three things:

1. The notification is **still in the notification center a minute later**.
2. Its title names the server rather than a category.
3. Clicking it from the notification center opens the message.

Turning on "Log to console" and opening DevTools shows the decisions as they happen.

## Tests

```
node test-plugin.js
```

31 checks against a stubbed `BdApi` and a fake notification module that mimics the real one:
title rewriting across every shape Discord emits, the retain rule, deep-link parsing, the
navigate-only-once-Discord-has-forgotten rule, concurrent notifications keeping separate state,
`stop()` fully restoring stock behaviour, and a missing module degrading quietly.

What tests cannot cover is webpack module discovery — `getByKeys("showNotification")` finding the
right object only happens inside Discord. That is the part most likely to break on a Discord
refactor, and the plugin shows an error toast rather than failing silently if it does.

## How it works

Three patches, all through `BdApi.Patcher`:

```js
Patcher.before(NAME, notifications, "showNotification", ...)   // rewrite the title
Patcher.after (NAME, notifications, "showNotification", ...)   // wrap the returned close()
Patcher.after (NAME, bridge,        "invoke",           ...)   // record identifier -> deep link
```

plus one listener on `NOTIFICATIONS_RECEIVED_RESPONSE` to see dismissals and clicks.

The interesting part is the second one. Discord's timer holds a reference to a plain object and
calls `close` on it when it fires — a property lookup five seconds later. So replacing that one
property on the returned object intercepts the removal, without needing to reach into the timer's
closure (impossible), redefine a webpack binding (non-configurable), or wrap `DiscordNative`
(frozen).

Discord's bridge offers no way to remove a listener, so exactly one is registered per Discord
session and routed to whichever plugin instance is live. Without that, BetterDiscord's hot-reload
would stack a new listener on every edit. Disabling the plugin makes it inert.

## Limitations

- **Windows only.** The bugs do not exist on macOS or Linux.
- The toast XML is built in Discord's main process, out of reach from here, so notification-center
  *grouping* by server (Windows toast headers) is not possible from a plugin.
- If Discord renames or restructures the modules this patches, the plugin reports an error and
  does nothing until updated.
