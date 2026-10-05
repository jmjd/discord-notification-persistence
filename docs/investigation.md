# How this was found

Kept partly because it documents the method for re-verifying on a future Discord version, and
partly because the wrong turns are instructive.

## Starting point

The symptom is widely reported and had no known fix: a toast appears, then disappears from the
notification center seconds later. One report mentioned event-log entries showing Discord showing
and then cancelling a notification, which suggested the client was doing it deliberately rather
than Windows expiring it.

## 1. Finding readable code

Discord's client ships seventeen separately-updatable modules under
`%LOCALAPPDATA%\Discord\app-<version>\modules\`. One is `discord_notifications`, and on Windows
its implementation is a single **plain, un-minified, un-hashed** JavaScript file:

```
modules/discord_notifications-1/discord_notifications/notifications_win.js
```

`manifest.json` beside it lists file names only — no hashes — so a modified copy is not detected.
That file calls `notification.close()` from `removeNotifications()`, which was the first concrete
lead.

## 2. A control experiment

Before blaming Discord, rule out Windows. `tools/probes/` does not contain this one, but the
test was: post a toast directly under Discord's AppUserModelID
(`com.squirrel.Discord.Discord`) via WinRT, and never close it.

It appeared and stayed in the notification center indefinitely. So Windows was not expiring
anything and Discord's app registration was healthy. Posting a second toast and then calling
`ToastNotifier.Hide()` on it reproduced the disappearance exactly — confirming `Hide()` revokes
rather than dismisses.

## 3. Instrumenting the real path

Replacing `notifications_win.js` with an instrumented copy produced the decisive timeline:

```
08:16:56.960 send
08:16:56.967 show
08:17:01.976 remove   (+5009ms, and no OS close event in between)
```

This killed the first hypothesis. The original guess was that Discord was echoing Windows'
auto-dismissal — that the OS hid the banner and Discord then "tidied up". Wrong: Windows never
emitted a close event at all. The removal was a blind timer started at `show`.

Worth stating plainly, because it shaped everything after: a fix keyed on the OS dismissal event
was written first, and did nothing. The log is what corrected it.

## 4. Finding the timer

Three console probes failed to find the renderer code responsible
(`tools/probes/discover.js`, `discover2.js`, `discover3.js`). Why they failed is useful:

- Searching the webpack factory map for the IPC constant `DISCORD_NOTIFICATIONS_REMOVE_NOTIFICATIONS`
  returned nothing, because the renderer calls it through a wrapper — `y.Ay.invoke(...)`, not
  `ipc.invoke(...)` — and the constant is not in the renderer bundle at all.
- Pushing a chunk onto `webpackChunkdiscord_app` yields a `__webpack_require__` whose cache held
  **102 instantiated modules out of 8352 factories**. Not nearly the whole running app. Any
  conclusion drawn from that keyhole is unreliable.
- A regex search for "a module mentioning notifications with a 5000ms timeout" produced a
  confident false positive: a 117KB channel-UI module that happened to contain both, where the
  timer was dismissing a safety-nudge tooltip.

What worked was DevTools' own **Search across all files** (Sources → Ctrl+Shift+F), searching
for `fallbackDeepLink` — a payload field name the main process demonstrably receives, so only the
genuine notification code could contain it. That found the function immediately, including the
timer, the `isMac()` gate and the response handler.

**Lesson:** when the target must contain a specific string, search the loaded scripts for that
string rather than reasoning about module graphs.

## 5. Establishing what could be patched

`tools/probes/discover5.js` through `discover7.js` settled the plugin's feasibility:

| Question | Answer |
|---|---|
| Can `DiscordNative` be wrapped? | **No.** `writable=false, configurable=false`, frozen, and `ipc` cannot be redefined. |
| Is the renderer's native bridge patchable? | **Yes.** `invoke`, `on` and `focus` are all writable and configurable. |
| Can a plugin receive clicks Discord has discarded? | **Yes.** Registering a second listener on `NOTIFICATIONS_RECEIVED_RESPONSE` fires even when Discord's own handler finds no record — and showed the response carries 4 arguments, not 5. |
| Is `transitionTo` reachable for navigation? | **No, not by that name.** But the module exposing `getHistory()` returns a normal history object, and `history.push(path)` navigates correctly. |

Two of those lookups initially returned "not found" because the filters omitted
`{ searchExports: true }`. If a `BdApi.Webpack` lookup fails, try that before concluding the
module is absent.

## 6. The interception point

The timer's callback is a closure — unreachable. The webpack binding it calls is a
non-configurable getter — unpatchable. But:

```js
let n = { close() { ... } };
...
G && setTimeout(() => e.close(), 5e3)
```

`n` is a **plain mutable object**, and the timer looks `close` up on it when it fires, five
seconds later. `showNotification` returns that object. So patching the returned object after the
fact is enough, and needs none of the unreachable parts:

```js
Patcher.after(NAME, module, "showNotification", (self, args, ret) =>
    ret.then(res => { /* wrap res.notification.close */ return res }));
```

## 7. Clicks

Rather than guess from elapsed time whether Discord still holds its record, the plugin watches
for the `dismiss` event that deletes it. That is the exact signal, so the plugin only steps in
when Discord genuinely cannot handle the click, and never navigates twice.

The identifier→deep-link association is captured by patching the bridge's `invoke`: the
`NOTIFICATIONS_SEND_NOTIFICATION` payload carries `fallbackDeepLink`, and the promise resolves to
the identifier. Those two facts are never in the same place in Discord's own code on Windows,
which is precisely why the fallback cannot work there.

## Re-verifying on a new Discord version

1. Enable DevTools: `node tools/probes/enable-devtools.js` (quit Discord first — it rewrites
   `settings.json` on exit and will overwrite the change otherwise).
2. Sources → Ctrl+Shift+F → `fallbackDeepLink`. Confirm the timer, the `isMac()` gate and the
   response handler still look as described in `root-cause.md`.
3. Run `discover5.js`, `discover6.js`, `discover7.js` to confirm the bridge is still patchable
   and the router still navigable.
4. `node tools/probes/enable-devtools.js --disable` when finished.
