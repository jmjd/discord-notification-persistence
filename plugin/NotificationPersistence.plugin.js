/**
 * @name NotificationPersistence
 * @author jmjd
 * @description Keeps Windows notifications in the notification center instead of deleting them five seconds after they appear, names the server they came from, and makes clicking them open the message.
 * @version 1.1.0
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

const FSI = '⁨';
const PDI = '⁩';

const SEND = 'NOTIFICATIONS_SEND_NOTIFICATION';
const RESPONSE = 'NOTIFICATIONS_RECEIVED_RESPONSE';

/* ---------------------------------------------------------------- pure helpers, testable */

/** Swap the category in "Sender (#channel, Category)" for the server name, or null. */
function rewriteTitleServer(title, server) {
    const t = String(title == null ? '' : title);
    if (server == null || String(server).trim() === '') return null;
    if (t.includes(server)) return null;

    let m = /^(.*\(⁨[^⁩]*⁩,\s*⁨)([^⁩]*)(⁩\)\s*)$/.exec(t);
    if (m != null) return m[1] + server + m[3];
    m = /^(.*\([^,()]*,\s*)([^()]*)(\)\s*)$/.exec(t);
    if (m != null) return m[1] + server + m[3];
    m = /^(.*\(⁨?[^⁩()]*⁩?)(\)\s*)$/.exec(t);
    if (m != null) return m[1] + ', ' + FSI + server + PDI + m[2];
    return null;
}

/** The retain rule: refuse a close that is the auto-clear timer. */
function shouldRefuseClose(state, now, cfg) {
    if (state == null) return false;
    if (state.clicked) return false;
    return now - state.shownAt <= cfg.timerWindowMs;
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

// Discord's bridge has no way to remove a listener, so one is registered per Discord session
// and delegates to whichever instance is currently running. That keeps BD's hot-reload from
// stacking up listeners.
let sharedListenerInstalled = false;
let liveInstance = null;

class NotificationPersistence {
    constructor() {
        this.cfg = Object.assign({}, DEFAULTS);
        this.states = new WeakMap();          // options object -> close-rule state
        this.byIdentifier = new Map();        // identifier -> { path, shownAt, discordForgot }
        this.active = false;
        this.stats = { refused: 0, allowed: 0, retitled: 0, navigated: 0 };
    }

    log(...args) {
        if (this.cfg.log) BdApi.Logger.info(NAME, ...args);
    }

    start() {
        this.cfg = Object.assign({}, DEFAULTS, BdApi.Data.load(NAME, 'settings') || {});
        const W = BdApi.Webpack;

        this.notifications = W.getByKeys('showNotification')
            || W.getByKeys('showNotification', { searchExports: true });
        if (this.notifications == null || typeof this.notifications.showNotification !== 'function') {
            BdApi.UI.showToast(NAME + ': could not find Discord\'s notification module. '
                + 'Discord has changed; the plugin is inactive.', { type: 'error', timeout: 8000 });
            BdApi.Logger.error(NAME, 'showNotification module not found; not patching.');
            return;
        }

        this.bridge = W.getByKeys('invoke', 'focus');
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
        // The shared listener stays registered -- the bridge exposes no way to remove one --
        // but it is inert while no instance is active.
        this.byIdentifier.clear();
        this.log('stopped', this.stats);
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
            const state = { shownAt: Date.now(), clicked: false };
            this.states.set(options, state);
            const originalClick = options.onClick;
            options.onClick = function (...clickArgs) {
                state.clicked = true;
                if (typeof originalClick === 'function') return originalClick.apply(this, clickArgs);
                return undefined;
            };
        }

        if (!this.cfg.serverName || this.GuildStore == null) return;
        try {
            const guildId = trackingProps != null ? trackingProps.guild_id : null;
            if (guildId == null) return;
            const guild = this.GuildStore.getGuild(guildId);
            if (guild == null || !guild.name) return;
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
        const state = this.states.get(args[4]) || { shownAt: Date.now(), clicked: false };

        return ret.then((res) => {
            try {
                const notification = res != null ? res.notification : null;
                if (notification == null || typeof notification.close !== 'function') return res;
                const realClose = notification.close.bind(notification);
                notification.close = () => {
                    if (shouldRefuseClose(state, Date.now(), this.cfg)) {
                        this.stats.refused++;
                        this.log('refused auto-clear', (Date.now() - state.shownAt) + 'ms after show');
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
            const path = deepLinkPath(payload != null ? payload.fallbackDeepLink : null);
            if (path == null) return;
            if (ret == null || typeof ret.then !== 'function') return;
            ret.then((result) => {
                const identifier = typeof result === 'string' ? result
                    : (result != null ? result.identifier : null);
                if (identifier == null) return;
                this.byIdentifier.set(identifier, { path, shownAt: Date.now(), discordForgot: false });
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
        const panel = document.createElement('div');
        panel.style.cssText = 'padding:16px;color:var(--text-normal);font-size:14px;';

        const row = (labelText, describeText, control) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'margin-bottom:20px;';
            const label = document.createElement('div');
            label.textContent = labelText;
            label.style.cssText = 'font-weight:600;margin-bottom:4px;';
            const describe = document.createElement('div');
            describe.textContent = describeText;
            describe.style.cssText = 'color:var(--text-muted);font-size:12px;margin-bottom:8px;';
            wrap.append(label, describe, control);
            panel.append(wrap);
        };
        const save = () => BdApi.Data.save(NAME, 'settings', this.cfg);
        const checkbox = (key) => {
            const el = document.createElement('input');
            el.type = 'checkbox';
            el.checked = this.cfg[key];
            el.onchange = () => { this.cfg[key] = el.checked; save(); };
            return el;
        };

        const windowInput = document.createElement('input');
        windowInput.type = 'number';
        windowInput.min = '1000';
        windowInput.step = '500';
        windowInput.value = String(this.cfg.timerWindowMs);
        windowInput.style.cssText = 'background:var(--input-background);color:var(--text-normal);'
            + 'border:1px solid var(--background-tertiary);border-radius:4px;padding:6px 8px;width:140px;';
        windowInput.onchange = () => {
            const v = parseInt(windowInput.value, 10);
            if (!Number.isNaN(v) && v >= 0) { this.cfg.timerWindowMs = v; save(); }
        };
        row('Auto-clear window (ms)',
            'A removal arriving within this long after a notification is shown, with no click '
            + 'from you, is Discord\'s auto-clear timer (~5000ms) and is refused. Later removals '
            + 'are honoured, so the notification center still empties normally.', windowInput);

        row('Show the server name',
            'Discord titles notifications "Sender (#channel, Category)" on Windows, naming the '
            + 'channel\'s category rather than the server. This replaces it with the server name.',
            checkbox('serverName'));

        row('Open the message when clicked',
            'Discord forgets a notification once the banner is dismissed, so clicking it later '
            + 'only focuses the window. This remembers where each one points and navigates there.',
            checkbox('reviveClicks'));

        row('Log to console', 'Records refusals, retitles and navigations, for debugging.',
            checkbox('log'));

        return panel;
    }
}

// Exposed for the Node test harness; harmless to BetterDiscord.
NotificationPersistence.rewriteTitleServer = rewriteTitleServer;
NotificationPersistence.shouldRefuseClose = shouldRefuseClose;
NotificationPersistence.deepLinkPath = deepLinkPath;
NotificationPersistence.shouldNavigate = shouldNavigate;
NotificationPersistence.DEFAULTS = DEFAULTS;

module.exports = NotificationPersistence;
