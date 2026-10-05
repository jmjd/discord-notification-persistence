/**
 * @name NotificationPersistence
 * @author jmjd
 * @description Keeps Windows notifications in the notification center instead of deleting them five seconds after they appear, names the server they came from, and makes clicking them open the message.
 * @version 1.2.0
 * @source https://github.com/jmjd/discord-notification-persistence/blob/main/plugin/NotificationPersistence.plugin.js
 * @website https://github.com/jmjd/discord-notification-persistence
 */

'use strict';

/*
 * THREE WINDOWS-ONLY GAPS IN DISCORD'S NOTIFICATION CODE
 *
 * 1. Every notification is destroyed 5s after it is shown:
 *
 *        function F(e, t) { ...; G && setTimeout(() => e.close(), 5e3) }
 *        let n = { close() { y.Ay.invoke("NOTIFICATIONS_REMOVE_NOTIFICATIONS", [t]) } };
 *        return w("shown", "none", "native"), F(n, i), { notification: n, trackingProps: i }
 *
 *    On Windows that reaches WinRT ToastNotifier.Hide(), which deletes the toast from the
 *    notification center rather than merely dismissing the banner. `n` is a plain object and
 *    the timer looks `close` up when it fires, so replacing that property intercepts it.
 *
 * 2. Server and sender metadata is only attached on macOS:
 *
 *        if (null != r.messageRecord && (0, L.isMac)()) {
 *            a.groupName = ...; a.senderDisplayName = ...; a.threadIdentifier = ...
 *        }
 *
 *    So Windows titles read "Sender (#channel, Category)" -- the channel's *category*. The
 *    title is an argument, so it can be rewritten from GuildStore before it is sent.
 *
 * 3. Clicking a notification the timer already destroyed does nothing. Discord's response
 *    handler drops its record on dismissal, then falls back to a deep link:
 *
 *        if ("dismiss" === t) return void delete Y[n];
 *        ...
 *        let e = Y[n];
 *        if (focus(), null != e) { e.options?.onClick?.(i); return }
 *        if (null != r) { ...parse r as a discord: URL...; (0, u.A)(pathname) }
 *
 *    That fallback never fires, because core.asar has two callback shapes and the one used
 *    here drops the deep link:
 *
 *        lib.setCallbacks((action, identifier, userText, fallbackDeepLink) => send(..., fallbackDeepLink), ...)
 *        lib.setCallbacks((action, identifier, userText)                  => send(...))
 *
 *    Confirmed live: the response arrives with 4 arguments, never 5. So this plugin keeps its
 *    own identifier -> deep link map, watches for the dismissal that makes Discord forget, and
 *    navigates itself when such a notification is clicked.
 */

const NAME = 'NotificationPersistence';

const DEFAULTS = {
    // A close() arriving within this long after a notification is shown, with no click from
    // you, is Discord's auto-clear timer (~5.0s) and is refused.
    timerWindowMs: 8000,
    // Rewrite the title to name the server instead of the channel's category.
    serverName: true,
    // Navigate on a click Discord has forgotten.
    reviveClicks: true,
    log: false,
    // Bound on the identifier -> deep link map.
    maxTracked: 300,
};

const FSI = '\u2068';
const PDI = '\u2069';

const SEND = 'NOTIFICATIONS_SEND_NOTIFICATION';
const RESPONSE = 'NOTIFICATIONS_RECEIVED_RESPONSE';

/* ---------------------------------------------------------------- pure helpers, testable */

/** Swap the category in "Sender (#channel, Category)" for the server name, or null. */
function rewriteTitleServer(title, server) {
    const t = String(title == null ? '' : title);
    if (server == null || String(server).trim() === '') return null;
    if (t.includes(server)) return null;

    let m = /^(.*\(\u2068[^\u2069]*\u2069,\s*\u2068)([^\u2069]*)(\u2069\)\s*)$/.exec(t);
    if (m != null) return m[1] + server + m[3];
    m = /^(.*\([^,()]*,\s*)([^()]*)(\)\s*)$/.exec(t);
    if (m != null) return m[1] + server + m[3];
    m = /^(.*\(\u2068?[^\u2069()]*\u2069?)(\)\s*)$/.exec(t);
    if (m != null) return m[1] + ', ' + FSI + server + PDI + m[2];
    return null;
}

/** The retain rule: refuse a close that is the auto-clear timer. */
function shouldRefuseClose(state, now, cfg) {
    if (state == null) return false;
    if (state.clicked) return false;
    return now - state.sentAt <= cfg.timerWindowMs;
}

/**
 * Stored settings are whatever was last written to disk, so every value is checked before use.
 * One bad number would otherwise disable the fix silently while the plugin still showed as
 * enabled: `now - sentAt <= NaN` is always false, so nothing would ever be refused.
 */
function sanitizeConfig(stored) {
    const cfg = Object.assign({}, DEFAULTS);
    if (stored == null || typeof stored !== 'object') return cfg;
    for (const key of ['timerWindowMs', 'maxTracked']) {
        const n = Number(stored[key]);
        if (Number.isFinite(n) && n >= 0) cfg[key] = n;
    }
    for (const key of ['serverName', 'reviveClicks', 'log']) {
        if (typeof stored[key] === 'boolean') cfg[key] = stored[key];
    }
    return cfg;
}

/**
 * The settings panel as data, for BdApi.UI.buildSettingsPanel. Kept pure and exported so the
 * schema can be checked against the real config without rendering anything: a typo in an `id`
 * would otherwise write a setting nobody reads, silently.
 *
 * `min` and `max` are required on a number setting by BetterDiscord's own types.
 */
function settingsSchema(cfg) {
    return [
        {
            type: 'number',
            id: 'timerWindowMs',
            name: 'Auto-clear window (ms)',
            note: 'A removal arriving within this long after a notification appears, with no click '
                + 'from you, is Discord\'s auto-clear timer and is refused. Discord\'s timer fires at '
                + 'about 5000ms. Removals after this window are allowed through, which is what lets '
                + 'the notification center still empty out for things you have read.',
            value: cfg.timerWindowMs,
            min: 1000,
            max: 30000,
            step: 500,
        },
        {
            type: 'switch',
            id: 'serverName',
            name: 'Show the server name',
            note: 'Discord titles notifications "Sender (#channel, Category)" on Windows, naming '
                + 'the channel\'s category rather than the server. This replaces it with the server name.',
            value: cfg.serverName,
        },
        {
            type: 'switch',
            id: 'reviveClicks',
            name: 'Open the message when clicked',
            note: 'Discord forgets a notification once its banner is dismissed, so clicking it '
                + 'later only focuses the window. This remembers where each one pointed and goes there.',
            value: cfg.reviveClicks,
        },
        {
            type: 'switch',
            id: 'log',
            name: 'Log to console',
            note: 'Records each refusal, retitle and navigation. Useful for checking the plugin '
                + 'still works after a Discord update.',
            value: cfg.log,
        },
    ];
}

// Discord's internal field names are not API, and when one goes missing this plugin degrades
// quietly -- no server name, or no navigation -- which is worse than saying so. These warn on the
// first occurrence only, so a changed field does not fill the console on every notification.
const warned = new Set();
function warnOnce(key, ...message) {
    if (warned.has(key)) return;
    warned.add(key);
    BdApi.Logger.warn(NAME, ...message);
}

/** Extract the in-app path from a discord: deep link, the way Discord's own fallback does. */
function deepLinkPath(link) {
    try {
        const url = new URL(String(link), 'https://discord.com');
        if (url.protocol !== 'discord:') return null;
        return url.pathname || null;
    }
    catch {
        return null;
    }
}

/**
 * Whether the plugin should navigate for a click. Only once Discord has actually dropped its
 * own record -- which we know exactly, because we see the dismissal that drops it. Before
 * that Discord handles the click itself and stepping in would navigate twice.
 */
function shouldNavigate(entry, cfg) {
    if (!cfg.reviveClicks) return false;
    if (entry == null) return false;
    if (!entry.discordForgot) return false;
    return entry.path != null;
}

/* ------------------------------------------------------------------------------- plugin */

/*
 * THE ONE THING stop() CANNOT UNDO, AND WHY
 *
 * Clicks and dismissals arrive on a renderer event, and registering for that event is one-way.
 * Checked against Discord 1.0.9260 rather than assumed (see tools/probes/discover8.js):
 *
 *   - the native bridge exposes 181 keys, and not one of them unregisters a listener
 *   - its `on` is `on(e, t) { g.ipc.on(e, t) }`, a pass-through to DiscordNative.ipc.on
 *   - DiscordNative.ipc exposes exactly `send`, `on` and `invoke`, and the object is frozen
 *     (writable=false, configurable=false), so no `off` can be reached or added
 *
 * The listener therefore outlives the plugin being disabled. It is made harmless rather than
 * removable: exactly one is ever registered per Discord session, and it does nothing unless an
 * enabled instance is live. stop() sets `active = false` and clears `liveInstance`, after which
 * the callback returns immediately -- there is a test for that. Reloading Discord (Ctrl+R) clears
 * the registration outright, since it belongs to that renderer.
 */
let sharedListenerInstalled = false;
let liveInstance = null;

class NotificationPersistence {
    constructor() {
        this.cfg = Object.assign({}, DEFAULTS);
        this.states = new WeakMap();          // options object -> close-rule state
        this.byIdentifier = new Map();        // identifier -> { path, sentAt, discordForgot }
        this.active = false;
        this.stats = { refused: 0, allowed: 0, retitled: 0, navigated: 0 };
    }

    log(...args) {
        if (this.cfg.log) BdApi.Logger.info(NAME, ...args);
    }

    start() {
        this.cfg = sanitizeConfig(BdApi.Data.load(NAME, 'settings'));
        const W = BdApi.Webpack;

        this.notifications = W.getByKeys('showNotification')
            || W.getByKeys('showNotification', { searchExports: true });
        if (this.notifications == null || typeof this.notifications.showNotification !== 'function') {
            BdApi.UI.showToast(NAME + ': could not find Discord\'s notification module. '
                + 'Discord has changed; the plugin is inactive.', { type: 'error', timeout: 8000 });
            BdApi.Logger.error(NAME, 'showNotification module not found; not patching.');
            return;
        }

        this.bridge = this.findBridge(W);
        this.router = W.getByKeys('getHistory', { searchExports: true });
        this.GuildStore = W.getByKeys('getGuild', 'getGuilds');
        if (this.GuildStore == null) BdApi.Logger.warn(NAME, 'GuildStore not found; server names off.');
        if (this.bridge == null) BdApi.Logger.warn(NAME, 'native bridge not found; click revival off.');
        if (this.router == null) BdApi.Logger.warn(NAME, 'router not found; click revival off.');

        BdApi.Patcher.before(NAME, this.notifications, 'showNotification',
            (_self, args) => this.onBeforeShow(args));
        BdApi.Patcher.after(NAME, this.notifications, 'showNotification',
            (_self, args, ret) => this.onAfterShow(args, ret));

        // Capture each notification's identifier and deep link as it is sent. Discord loses
        // the association; this is what makes a forgotten click recoverable.
        if (this.bridge != null) {
            BdApi.Patcher.after(NAME, this.bridge, 'invoke',
                (_self, args, ret) => { this.onInvoke(args, ret); });
            this.installResponseListener();
        }

        liveInstance = this;
        this.active = true;
        this.log('started');
    }

    stop() {
        this.active = false;
        if (liveInstance === this) liveInstance = null;
        BdApi.Patcher.unpatchAll(NAME);
        this.byIdentifier.clear();
        // Everything this plugin did is now undone except the response listener, which cannot be
        // unregistered at all -- see the note above sharedListenerInstalled. It is inert from here:
        // `active` is false and `liveInstance` is null, so its callback returns immediately.
        this.log('stopped', this.stats);
    }

    /**
     * Discord's native-module bridge. `invoke` and `focus` alone are generic enough to match some
     * other module after a refactor, so `requireModule` -- distinctive to this bridge -- is asked
     * for as well, and whatever comes back is checked for the three methods actually used. The
     * looser lookup is kept as a fallback in case `requireModule` is the thing that gets renamed.
     */
    findBridge(W) {
        const usable = (mod) => mod != null
            && typeof mod.invoke === 'function'
            && typeof mod.on === 'function'
            && typeof mod.focus === 'function';

        const strict = W.getByKeys('invoke', 'focus', 'requireModule');
        if (usable(strict)) return strict;

        const loose = W.getByKeys('invoke', 'focus');
        if (usable(loose)) {
            BdApi.Logger.warn(NAME, 'native bridge found without requireModule; '
                + 'Discord may have restructured it. Click revival may be unreliable.');
            return loose;
        }
        return null;
    }

    installResponseListener() {
        if (sharedListenerInstalled) return;
        if (typeof this.bridge.on !== 'function') return;
        try {
            this.bridge.on(RESPONSE, (_event, action, identifier, userText) => {
                const self = liveInstance;
                if (self == null || !self.active) return;
                self.onResponse(action, identifier, userText);
            });
            sharedListenerInstalled = true;
        }
        catch (err) {
            BdApi.Logger.warn(NAME, 'could not listen for notification responses', err);
        }
    }

    /** Before Discord builds the payload: rewrite the title, and watch for a click. */
    onBeforeShow(args) {
        const trackingProps = args[3];
        const options = args[4];

        if (options != null && typeof options === 'object') {
            // Keyed on the options object rather than the notification's identifier, because the
            // identifier does not exist yet -- Discord assigns it further down, and the `after`
            // patch receives this same object, so it can find the state again.
            const state = { sentAt: Date.now(), clicked: false };
            this.states.set(options, state);
            // Safe to wrap in place: Discord builds a fresh options literal for every
            // notification (see its MESSAGE_CREATE handler), so these cannot stack up.
            const originalClick = options.onClick;
            options.onClick = function (...clickArgs) {
                state.clicked = true;
                if (typeof originalClick === 'function') return originalClick.apply(this, clickArgs);
                return undefined;
            };
        }

        if (!this.cfg.serverName || this.GuildStore == null) return;
        try {
            if (trackingProps == null || typeof trackingProps !== 'object') {
                warnOnce('tracking-props', 'notification sent without tracking props; '
                    + 'server names are unavailable. Discord may have changed its arguments.');
                return;
            }
            const guildId = trackingProps.guild_id;
            if (guildId == null) return;          // a direct message, which has no server
            const guild = this.GuildStore.getGuild(guildId);
            if (guild == null || !guild.name) {
                warnOnce('guild-lookup', 'GuildStore had no name for guild ' + guildId
                    + '; server names will be missing for it.');
                return;
            }
            const rewritten = rewriteTitleServer(args[1], guild.name);
            if (rewritten != null) {
                args[1] = rewritten;
                this.stats.retitled++;
                this.log('retitled ->', rewritten);
            }
        }
        catch (err) {
            BdApi.Logger.warn(NAME, 'title rewrite failed', err);
        }
    }

    /** After: wrap the returned notification's close() with the retain rule. */
    onAfterShow(args, ret) {
        if (ret == null || typeof ret.then !== 'function') return ret;
        const state = this.states.get(args[4]) || { sentAt: Date.now(), clicked: false };

        return ret.then((res) => {
            try {
                const notification = res != null ? res.notification : null;
                if (notification == null || typeof notification.close !== 'function') return res;
                // Replaced directly rather than through BdApi.Patcher: Patcher targets named
                // methods on persistent objects, and this is a throwaway object Discord creates
                // per notification. Its timer looks the close property up when it fires, so
                // swapping that property is what intercepts the removal.
                const realClose = notification.close.bind(notification);
                notification.close = () => {
                    if (shouldRefuseClose(state, Date.now(), this.cfg)) {
                        this.stats.refused++;
                        this.log('refused auto-clear', (Date.now() - state.sentAt) + 'ms after send');
                        return undefined;
                    }
                    this.stats.allowed++;
                    return realClose();
                };
            }
            catch (err) {
                BdApi.Logger.warn(NAME, 'could not wrap close()', err);
            }
            return res;
        });
    }

    /** Records identifier -> deep link, the association Discord throws away. */
    onInvoke(args, ret) {
        try {
            if (args[0] !== SEND) return;
            const payload = args[1];
            const link = payload != null ? payload.fallbackDeepLink : null;
            const path = deepLinkPath(link);
            if (path == null) {
                // A notification with no deep link is normal. One carrying a link we cannot read
                // means the format changed, and clicks will stop navigating -- worth saying once.
                if (link != null) {
                    warnOnce('deep-link-shape', 'could not read an in-app path out of '
                        + String(link) + '; clicks on forgotten notifications will not navigate.');
                }
                return;
            }
            if (ret == null || typeof ret.then !== 'function') return;
            ret.then((result) => {
                const identifier = typeof result === 'string' ? result
                    : (result != null ? result.identifier : null);
                if (identifier == null) return;
                this.byIdentifier.set(identifier, { path, sentAt: Date.now(), discordForgot: false });
                while (this.byIdentifier.size > this.cfg.maxTracked) {
                    const oldest = this.byIdentifier.keys().next();
                    if (oldest.done) break;
                    this.byIdentifier.delete(oldest.value);
                }
            }).catch(() => { });
        }
        catch (err) {
            BdApi.Logger.warn(NAME, 'could not record deep link', err);
        }
    }

    /** Discord's own handler runs too; this only steps in once it has lost the record. */
    onResponse(action, identifier) {
        const entry = this.byIdentifier.get(identifier);
        if (entry == null) return;

        // The dismissal is exactly what makes Discord drop its record, so note it rather than
        // guessing from elapsed time. The entry itself is kept -- it is the only remaining
        // route back to the message.
        if (action === 'dismiss' || action === 'failed') {
            entry.discordForgot = true;
            return;
        }

        if (!shouldNavigate(entry, this.cfg)) return;
        if (this.router == null) return;
        try {
            const history = this.router.getHistory();
            if (history == null || typeof history.push !== 'function') return;
            history.push(entry.path);
            this.stats.navigated++;
            this.log('navigated to', entry.path);
        }
        catch (err) {
            BdApi.Logger.warn(NAME, 'navigation failed', err);
        }
    }

    getSettingsPanel() {
        // Discord's own controls, rather than hand-built DOM. The data comes from a pure
        // function so the schema is testable; only this call is not.
        return BdApi.UI.buildSettingsPanel({
            settings: settingsSchema(this.cfg),
            onChange: (_categoryId, id, value) => {
                // Routed through sanitizeConfig so a value arriving from the panel is held to
                // the same rules as one read from disk.
                this.cfg = sanitizeConfig(Object.assign({}, this.cfg, { [id]: value }));
                BdApi.Data.save(NAME, 'settings', this.cfg);
                this.log('setting changed', id, this.cfg[id]);
            },
        });
    }
}

// Exposed for the Node test harness; harmless to BetterDiscord.
NotificationPersistence.rewriteTitleServer = rewriteTitleServer;
NotificationPersistence.shouldRefuseClose = shouldRefuseClose;
NotificationPersistence.deepLinkPath = deepLinkPath;
NotificationPersistence.shouldNavigate = shouldNavigate;
NotificationPersistence.sanitizeConfig = sanitizeConfig;
NotificationPersistence.settingsSchema = settingsSchema;
NotificationPersistence.DEFAULTS = DEFAULTS;

module.exports = NotificationPersistence;
