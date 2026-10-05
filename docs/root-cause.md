# Root cause

Three Windows-only bugs in Discord's notification handling. Everything below was read out of a
live Discord client (stable 1.0.9256) — the renderer bundle via DevTools, the main-process code
from `core.asar` on disk — and verified by instrumenting the notification module and watching
real notifications.

## Where the code lives

Discord desktop is an Electron app, so the relevant code is spread across three runtimes:

```
Renderer (Chromium)         React app, webpack bundles fetched from Discord's CDN at
                            runtime, never written to disk. Shared codebase with
                            discord.com in a browser.
                              -> bug 1 (the timer), bug 2 (the isMac gate)

Preload / contextBridge     window.DiscordNative — frozen and non-configurable

Main process (Node)         core.asar: IPC handlers, OS integration
                              -> bug 3 (the dropped argument)
                            modules/discord_notifications/notifications_win.js:
                            builds the toast XML, calls Electron's Notification

Native addons (.node)       discord_notifications.node — macOS only

OS                          WinRT ToastNotifier
```

That spread matters: no single layer contains the whole problem.

## Bug 1 — notifications are destroyed after five seconds

In the renderer, immediately after a notification is shown:

```js
function F(e, t) {
    r.onShown?.(),
    r.omitViewTracking || (/* analytics */),
    G && setTimeout(() => e.close(), 5e3)
}

let n = { close() { y.Ay.invoke("NOTIFICATIONS_REMOVE_NOTIFICATIONS", [t]) } };
return w("shown", "none", "native"), F(n, i), { notification: n, trackingProps: i }
```

`G` is a module constant, so this is unconditional in practice. The chain is:

```
setTimeout 5s -> n.close() -> IPC NOTIFICATIONS_REMOVE_NOTIFICATIONS
             -> notifications_win.js removeNotifications()
             -> Electron notification.close()
             -> WinRT ToastNotifier.Hide()
```

`Hide()` is the problem. It does not dismiss the banner — Windows has already done that on its
own schedule — it **revokes the notification**, removing it from the notification center.

### Why this line exists

`F()` is called from both notification paths:

```js
F(n, i)   // n = the native-module wrapper: close() revokes the notification
F(l, i)   // l = an HTML5 `new Notification(...)`: close() dismisses a banner
```

Discord's renderer is shared with the web client, where notifications are plain
`new Notification(...)` objects that persist until something closes them. There,
`setTimeout(close, 5000)` is not a bug — it is what gives a web notification a lifetime.

When a native notification module was added, the wrapper object was passed to the same helper.
One unchanged line, whose meaning silently changed from "stop showing this banner" to "delete
this from the user's notification center."

### Measured

| Run | Interval between `show` and the removal |
|---|---|
| 1 | 5009ms |
| 2 | 5007ms |
| 3 | 4995ms |
| 4 | 5006ms |

No OS dismissal event is involved — Windows does not emit `close` for a banner that merely times
out, which is why the removal arrives before any OS signal, not after it.

## Bug 2 — the server name is never sent

Also in the renderer, building the payload for the native module:

```js
if (null != r.messageRecord && (0, L.isMac)()) {
    let e = r.messageRecord.channel_id, t = r.messageRecord.author;
    a.threadIdentifier = e;
    let n = T.A.getChannel(e);
    null != n && (a.groupName = (0, d.m1)(n, N.default, g.A));
    let i = n?.getGuildId();
    a.senderIdentifier = t.id,
    a.senderDisplayName = R.Ay.getName(i, e, t),
    a.senderAvatar = t.getAvatarURL(i, 128, !1, !1),
    ...
}
```

Every enrichment field is inside the `isMac()` branch. Windows receives only `title`, `body`,
`icon` and `fallbackDeepLink`.

This also explains a stub on the other side of the boundary. In `notifications_win.js`:

```js
supportsHeaders() {
    return false;
}
```

Windows toast *headers* group notifications in the notification center, and they are built from
`groupName`. The header code is fully written directly below that `return false`. It is switched
off because `groupName` never arrives — and `groupName` is not sent because nothing on Windows
consumed it. Each half is justified by the other.

The title Windows actually receives, read back out of the Windows notification database:

```xml
<text><FSI>NotificationFix Hook<PDI> (<FSI>#testing<PDI>, <FSI>Text Channels<PDI>)</text>
<text><FSI>@someone<PDI> the message body</text>
```

`Text Channels` is the channel's *category*, which is Discord's default category name in a new
server.

`<FSI>` and `<PDI>` above stand in for invisible Unicode isolate characters — U+2068 FIRST STRONG
ISOLATE and U+2069 POP DIRECTIONAL ISOLATE — which Discord wraps around every name so that a
right-to-left username cannot scramble the text around it. Any rewrite has to preserve them, or
the title renders with stray direction marks. They are written here as visible markers rather than
embedded directly: the real payload contains the actual characters, and a file containing them
gets flagged by GitHub as hidden Unicode, which is the same class of character behind the Trojan
Source attack (CVE-2021-42574). In the source they appear as `\u2068` / `\u2069` escapes for the
same reason.

## Bug 3 — clicking a notification does nothing

Discord's response handler, in the renderer:

```js
y.Ay.on("NOTIFICATIONS_RECEIVED_RESPONSE", (e, t, n, i, r) => {
    if ("failed" === t) { w("failed", "native_ipc_error", "native"), delete Y[n]; return }
    if ("dismiss" === t) return void delete Y[n];          // <- the record is dropped here
    {
        let e = Y[n];
        if (L.isPlatformEmbedded ? y.Ay.focus() : window.focus(),   // focus always happens
            null != e) {
            ...
            e.options?.onClick?.(i);
            return
        }
        if (null != r) {                                   // <- the fallback, never reached
            let e = function(e) {
                try {
                    let t = new URL(e, location.origin);
                    if ("discord:" === t.protocol) return t.pathname
                } catch (e) {}
                return null
            }(r);
            null != e && (0, u.A)(e)
        }
    }
});
```

Two things combine:

1. Windows auto-hides the banner at about six seconds. That is reported as a `dismiss`, which
   deletes `Y[identifier]` — Discord's own record of what the notification pointed at.
2. A later click therefore finds no record. The handler focuses the window (unconditionally,
   before the lookup — which is exactly the symptom: Discord comes to the front but does not
   navigate), then reaches the deep-link fallback.

The fallback would handle this perfectly. It never fires, because `r` is always `undefined` on
Windows. From `core.asar`:

```js
lib.setCallbacks((action, identifier, userText, fallbackDeepLink) => {
    sendToAllWindows(IPCEvents.NOTIFICATIONS_RECEIVED_RESPONSE, action, identifier, userText, fallbackDeepLink)
}, ...)

lib.setCallbacks((action, identifier, userText) => {
    sendToAllWindows(IPCEvents.NOTIFICATIONS_RECEIVED_RESPONSE, action, identifier, userText)
})
```

Two callback shapes for two platforms. The second one — the Windows path — drops the deep link.
Confirmed by registering a listener on that event and clicking a notification: it fires with
**four** arguments, never five.

So Discord ships a field called `fallbackDeepLink`, populates it on Windows, writes the handler
that consumes it, and then discards it in transit.

## A note on intent

A reasonable first reaction is that this must be deliberate. The code says otherwise. Discord
built the metadata fields, the header support and the deep-link fallback, then left all three
unwired on Windows. `fallbackDeepLink` in particular only makes sense for a notification that
survives long enough to be clicked later — it is evidence *against* notifications being meant to
be ephemeral.

The likeliest explanation is that the native notification module was built because macOS needed
it (permission handshakes, grouping, rich actions — the API surface is modelled on Apple's
`UNUserNotificationCenter`, including `authorizationStatus: 'provisional'`). The web
`Notification` API already worked on Windows, so Windows got a thin adapter to keep the shared
code path from forking, with the parts it could not use left as stubs.

And nothing measures the failure. Discord's own telemetry logs `w("shown", "none", "native")` —
the notification *was* shown. Nothing checks whether it still exists thirty seconds later, in a
surface users only look at when they have already missed something. A click that lands on a
deleted record is indistinguishable, in telemetry, from a notification nobody clicked.
