'use strict';
/*
 * Discord Windows notification fix -- installed as
 *   %LOCALAPPDATA%\Discord\app-<ver>\modules\discord_notifications-<n>\discord_notifications\notifications_win.js
 *
 * This file does NOT contain a copy of Discord's module. Discord's own file is kept beside it as
 * notifications_win.stock.js and does all the real work; this wraps its six exports and changes
 * three behaviours. That means no Discord code is redistributed, and a Discord update to that
 * file keeps working as long as its exports stay the same shape.
 *
 * WHAT IT CHANGES
 *
 * 1. Discord's renderer destroys every notification ~5s after showing it. On Windows that
 *    removal reaches WinRT ToastNotifier.Hide(), which deletes the toast from the notification
 *    center rather than dismissing the banner. A removal arriving inside `timerWindowMs` of
 *    sending, with no click, is refused.
 *
 * 2. Discord only attaches server/sender metadata on macOS (the whole block is inside an
 *    `isMac()` branch), so Windows titles read "Sender (#channel, Category)" -- the channel's
 *    category. `options.title` flows untouched into the toast XML, so rewriting it here is
 *    enough to name the server instead.
 *
 * 3. A click on a notification Discord has forgotten does nothing. Discord's own fallback would
 *    navigate using a deep link, but core.asar's Windows callback drops that argument before
 *    sending the response. The response is re-sent here with the deep link in place, so
 *    Discord's own handler does the navigating.
 *
 * Config is re-read while running (throttled), so settings can be changed without restarting
 * Discord. Only this file's code needs a restart.
 */

const electron = require('electron');
const fs_1 = require('fs');
const stock = require('./notifications_win.stock.js');

exports.setCallbacks = setCallbacks;
exports.getAuthorization = getAuthorization;
exports.getSettings = getSettings;
exports.sendNotification = sendNotification;
exports.removeNotifications = removeNotifications;
exports.removeAllNotifications = removeAllNotifications;

const CONFIG_PATH = '__CONFIG_PATH__';
const SERVERS_PATH = '__SERVERS_PATH__';
const DEFAULTS = {
    mode: 'fix',
    // A removal arriving within this long of sending, with no click, is Discord's auto-clear
    // timer (measured at ~5.0s) and is refused.
    timerWindowMs: 8000,
    // Fallback rule for builds that report an OS dismissal before the removal.
    graceMs: 20000,
    // 'replace' rewrites Discord's title, swapping the channel category for the server name.
    // 'title' appends the server instead. 'off' leaves titles alone.
    serverName: 'replace',
    reviveClicks: true,
    // 'ipc' hands the renderer the deep link core.asar drops, so Discord navigates natively.
    // 'protocol' goes out through the discord:// handler instead.
    clickMode: 'ipc',
    discoverServers: true,
    log: true,
    logFile: '__LOG_PATH__',
    maxTracked: 300,
};

let cfg = Object.assign({}, DEFAULTS);
let cfgReadAt = 0;
function loadConfig() {
    if (Date.now() - cfgReadAt < 2000) return;
    cfgReadAt = Date.now();
    try { Object.assign(cfg, DEFAULTS, JSON.parse(fs_1.readFileSync(CONFIG_PATH, 'utf8'))); }
    catch { /* keep whatever we last had */ }
}
loadConfig();

function log(event, identifier, extra) {
    if (!cfg.log) return;
    try {
        const id = identifier == null ? '-' : String(identifier).slice(0, 8);
        fs_1.appendFileSync(cfg.logFile, new Date().toISOString() + ' ' + event + ' ' + id
            + (extra != null ? ' ' + extra : '') + '\n');
    }
    catch { /* logging must never break a notification */ }
}

/* ------------------------------------------------------------------ server names */

let servers = {};
let serversReadAt = 0;
function loadServers() {
    if (Date.now() - serversReadAt < 2000) return;
    serversReadAt = Date.now();
    try { servers = JSON.parse(fs_1.readFileSync(SERVERS_PATH, 'utf8')); }
    catch { /* keep whatever we last had */ }
}

function guildIdFrom(deepLink) {
    const m = /\/channels\/(\d+)\//.exec(String(deepLink == null ? '' : deepLink));
    return m != null ? m[1] : null;
}

function rememberUnknownGuild(guildId, hint) {
    try {
        let current = {};
        try { current = JSON.parse(fs_1.readFileSync(SERVERS_PATH, 'utf8')); } catch { }
        if (Object.prototype.hasOwnProperty.call(current, guildId)) return;
        current[guildId] = '';
        current['_hint_' + guildId] = hint;
        fs_1.writeFileSync(SERVERS_PATH, JSON.stringify(current, null, 2));
        servers = current;
    }
    catch { /* a read-only map is not worth breaking a notification over */ }
}

function serverLabel(options) {
    const given = options.groupName != null ? String(options.groupName).trim() : '';
    if (given !== '') return given;
    const guildId = guildIdFrom(options.fallbackDeepLink);
    if (guildId == null) return '';
    loadServers();
    const mapped = servers[guildId];
    if (mapped != null && String(mapped).trim() !== '') return String(mapped).trim();
    rememberUnknownGuild(guildId, String(options.title == null ? '' : options.title));
    return '';
}

// Discord wraps each name in Unicode isolate characters (U+2068 first strong isolate, U+2069 pop
// directional isolate). They must survive the rewrite or the title renders with stray direction
// marks. Returns null when the title is not a shape we recognise, so it can be left alone.
const FSI = '⁨';
const PDI = '⁩';
function rewriteTitleServer(title, server) {
    const t = String(title == null ? '' : title);
    let m = /^(.*\(⁨[^⁩]*⁩,\s*⁨)([^⁩]*)(⁩\)\s*)$/.exec(t);
    if (m != null) return m[1] + server + m[3];
    m = /^(.*\([^,()]*,\s*)([^()]*)(\)\s*)$/.exec(t);
    if (m != null) return m[1] + server + m[3];
    m = /^(.*\(⁨?[^⁩()]*⁩?)(\)\s*)$/.exec(t);
    if (m != null) return m[1] + ', ' + FSI + server + PDI + m[2];
    return null;
}
exports.rewriteTitleServer = rewriteTitleServer;

function cleanServerName(label) {
    let name = String(label == null ? '' : label);
    let before;
    do {
        before = name;
        name = name
            .replace(/^\s*\d+\s+(mention|unread|notification|message)s?\s*,\s*/i, '')
            .replace(/^\s*(unread|new messages?|mentions?)\s*,\s*/i, '')
            .replace(/\s*,\s*\d+\s+(mention|unread|notification|message)s?\s*$/i, '')
            .replace(/\s*\((server|guild)\)\s*$/i, '')
            .trim();
    } while (name !== before);
    return name;
}
exports.cleanServerName = cleanServerName;

/** The title to send, or null to leave it as Discord built it. */
function decorateTitle(title, server) {
    if (server === '' || cfg.serverName === 'off') return null;
    if (String(title == null ? '' : title).includes(server)) return null;   // already named
    if (cfg.serverName === 'title') {
        return title != null && title !== '' ? title + ' • ' + server : null;
    }
    if (cfg.serverName === 'replace') return rewriteTitleServer(title, server);
    return null;
}
exports.decorateTitle = decorateTitle;

/* ------------------------------------------------------------------ the retain rule */

const entries = new Map();   // identifier -> { sentAt, closedAt, clickedAt, retained, deepLink }

/**
 * Why a removal should be refused, or null to let it through. Keyed on send time rather than the
 * OS "shown" event: Discord's timer runs from display, which is a few milliseconds after send,
 * and timerWindowMs has far more margin than that.
 */
function retainReason(entry, now) {
    if (cfg.mode !== 'fix') return null;
    if (entry.clickedAt != null) return null;
    if (now - entry.sentAt <= cfg.timerWindowMs) {
        return 'auto-clear timer, ' + (now - entry.sentAt) + 'ms after send';
    }
    if (entry.closedAt != null && now - entry.closedAt <= cfg.graceMs) {
        return 'echo of OS dismissal, ' + (now - entry.closedAt) + 'ms after close';
    }
    return null;
}
exports.retainReason = retainReason;

function trim() {
    while (entries.size > cfg.maxTracked) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
    }
}

/* ------------------------------------------------------------------ click revival */

// Discord's response handler falls back to a deep link when it no longer holds a record of the
// notification -- but core.asar's Windows callback never sends that argument. Re-sending the
// response with it lets Discord navigate itself.
const RESPONSE_CHANNEL = 'DISCORD_NOTIFICATIONS_RECEIVED_RESPONSE';

function mainWindow() {
    const windows = electron.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    return windows.sort((a, b) => b.getBounds().width - a.getBounds().width)[0];
}

function focusMainWindow() {
    const win = mainWindow();
    if (win == null) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

function reviveClick(entry, identifier, userText) {
    try {
        if (entry.deepLink == null || entry.deepLink === '') {
            focusMainWindow();
            log('revive', identifier, 'focused window only (Discord supplied no deep link)');
            return;
        }
        if (cfg.clickMode === 'protocol') {
            focusMainWindow();
            electron.shell.openExternal(entry.deepLink);
            log('revive', identifier, 'focused window and opened deep link (protocol)');
            return;
        }
        let delivered = 0;
        for (const w of electron.BrowserWindow.getAllWindows()) {
            if (w.isDestroyed()) continue;
            w.webContents.send(RESPONSE_CHANNEL, 'clicked', identifier, userText, entry.deepLink);
            delivered++;
        }
        log('revive', identifier, 'sent response with deep link to ' + delivered + ' window(s)');
    }
    catch (err) {
        log('revive-failed', identifier, String(err && err.message ? err.message : err));
    }
}

/* ------------------------------------------------------------------ wrapped exports */

let appCallback = () => { };

// Discord's own handler is replaced with ours so clicks and dismissals can be observed, then
// forwarded on unchanged. Any further callbacks core.asar passes are handed through untouched.
function setCallbacks(...args) {
    appCallback = typeof args[0] === 'function' ? args[0] : () => { };
    const forwarded = args.slice();
    forwarded[0] = onNotificationAction;
    return stock.setCallbacks(...forwarded);
}

function onNotificationAction(action, identifier, userText) {
    loadConfig();
    const entry = entries.get(identifier);
    if (entry != null) {
        if (action === 'dismiss') entry.closedAt = Date.now();
        if (action === 'clicked') entry.clickedAt = Date.now();
        log(action === 'dismiss' ? 'os-close' : action, identifier,
            'sinceSend=' + (Date.now() - entry.sentAt) + 'ms'
            + (action === 'clicked' && entry.retained ? ' [Discord has already forgotten this one]' : ''));
    }

    appCallback(action, identifier, userText);

    // Only step in once a removal has been refused -- before that Discord still holds its own
    // record and handles the click itself.
    if (action === 'clicked' && entry != null && entry.retained && cfg.reviveClicks !== false) {
        reviveClick(entry, identifier, userText);
    }
}

function getAuthorization(...args) {
    return stock.getAuthorization(...args);
}

function getSettings(...args) {
    return stock.getSettings(...args);
}

async function sendNotification(options) {
    loadConfig();
    let outgoing = options;
    let titleMode = 'off';

    const label = serverLabel(options);
    if (label !== '') {
        const rewritten = decorateTitle(options.title, label);
        if (rewritten != null) {
            outgoing = Object.assign({}, options, { title: rewritten });
            titleMode = cfg.serverName;
        }
    }

    const result = await stock.sendNotification(outgoing);
    // Discord's renderer accepts either shape back from this call ("string" == typeof s ? ... : s),
    // so tolerate both rather than assuming the object form.
    const identifier = typeof result === 'string' ? result
        : (result != null ? result.identifier : null);
    if (identifier != null) {
        entries.set(identifier, {
            sentAt: Date.now(),
            closedAt: null,
            clickedAt: null,
            retained: false,
            deepLink: options.fallbackDeepLink,
        });
        trim();
    }
    // Message text is never logged -- only lengths, plus what the two extra features depend on.
    log('send', identifier, 'titleLen=' + (options.title != null ? String(options.title).length : 0)
        + ' bodyLen=' + (options.body != null ? String(options.body).length : 0)
        + ' server=' + (label !== '' ? '"' + label + '"' : 'none')
        + ' guild=' + (guildIdFrom(options.fallbackDeepLink) || 'none')
        + ' deepLink=' + (options.fallbackDeepLink ? 'yes' : 'none')
        + ' titleMode=' + titleMode);
    return result;
}

function removeNotifications(identifiers) {
    loadConfig();
    const now = Date.now();
    const honour = [];
    for (const identifier of identifiers) {
        const entry = entries.get(identifier);
        if (entry == null) {
            honour.push(identifier);
            log('remove-unknown', identifier);
            continue;
        }
        const reason = retainReason(entry, now);
        if (reason != null) {
            entry.retained = true;
            // Kept in the map: it is the only remaining route back to the message on a click.
            log('remove-refused', identifier, 'sinceSend=' + (now - entry.sentAt) + 'ms ['
                + reason + '] kept in notification center');
            continue;
        }
        honour.push(identifier);
        entries.delete(identifier);
        log('remove-closed', identifier, 'sinceSend=' + (now - entry.sentAt) + 'ms'
            + (entry.retained ? ' (deliberate, after earlier refusal)' : ''));
    }
    if (honour.length === 0) return Promise.resolve();
    return stock.removeNotifications(honour);
}

function removeAllNotifications() {
    loadConfig();
    const now = Date.now();
    if (entries.size === 0) return stock.removeAllNotifications();

    // Expressed as a selective removal so refused notifications survive a blanket clear.
    const honour = [];
    let refused = 0;
    for (const [identifier, entry] of entries) {
        if (retainReason(entry, now) != null) {
            entry.retained = true;
            refused++;
            continue;
        }
        honour.push(identifier);
    }
    for (const identifier of honour) entries.delete(identifier);
    log('remove-all', null, 'closed=' + honour.length + ' refused=' + refused);
    if (honour.length === 0) return Promise.resolve();
    return stock.removeNotifications(honour);
}

/* ------------------------------------------------------------------ server discovery */

// Guild names live only in the running client's memory; no local file holds them. This reads them
// off Discord's own sidebar in the renderer -- a DOM read of what is already on screen. No API
// call, no account token, no automation of the account.
function discoverServerNames() {
    const SCRIPT = `(() => {
        const out = {};
        const add = (id, name) => {
            if (/^\\d{17,20}$/.test(id) && name && out[id] == null) out[id] = String(name);
        };
        document.querySelectorAll('[data-list-item-id^="guildsnav___"]').forEach((el) => {
            const id = el.getAttribute('data-list-item-id').replace('guildsnav___', '');
            const named = el.matches('[data-dnd-name]') ? el
                : (el.querySelector('[data-dnd-name]') || el.closest('[data-dnd-name]'));
            if (named) add(id, named.getAttribute('data-dnd-name'));
            const labelled = el.querySelector('[aria-label]');
            if (labelled) add(id, labelled.getAttribute('aria-label'));
        });
        document.querySelectorAll('a[href^="/channels/"][aria-label]').forEach((el) => {
            const m = /^\\/channels\\/(\\d{17,20})/.exec(el.getAttribute('href'));
            if (m) add(m[1], el.getAttribute('aria-label'));
        });
        return out;
    })()`;
    try {
        const win = mainWindow();
        if (win == null || win.webContents == null || win.webContents.isLoading()) {
            log('discover', null, 'no loaded window yet, will retry');
            return Promise.resolve(null);
        }
        return Promise.resolve(win.webContents.executeJavaScript(SCRIPT, true)).then((raw) => {
            if (raw == null || typeof raw !== 'object') return null;
            const found = {};
            for (const [id, label] of Object.entries(raw)) {
                const name = cleanServerName(label);
                if (name !== '') found[id] = name;
            }
            let current = {};
            try { current = JSON.parse(fs_1.readFileSync(SERVERS_PATH, 'utf8')); } catch { }
            // Discord is the source of truth, so a rename there wins. Servers the scrape did not
            // see (a collapsed folder, say) are left untouched.
            let added = 0;
            let renamed = 0;
            for (const [id, name] of Object.entries(found)) {
                const existing = current[id];
                delete current['_hint_' + id];
                if (existing === name) continue;
                if (existing == null || String(existing).trim() === '') added++;
                else renamed++;
                current[id] = name;
            }
            delete current._discovered;
            fs_1.writeFileSync(SERVERS_PATH, JSON.stringify(current, null, 2));
            servers = current;
            serversReadAt = Date.now();
            log('discover', null, 'found=' + Object.keys(found).length
                + ' new=' + added + ' renamed=' + renamed);
            return found;
        }).catch((err) => {
            log('discover-failed', null, String(err && err.message ? err.message : err));
            return null;
        });
    }
    catch (err) {
        log('discover-failed', null, String(err && err.message ? err.message : err));
        return Promise.resolve(null);
    }
}
exports.discoverServerNames = discoverServerNames;

log('module-loaded', null, 'wrapper mode=' + cfg.mode + ' timerWindowMs=' + cfg.timerWindowMs);

if (cfg.discoverServers !== false) {
    let attempts = 0;
    const retry = () => {
        attempts++;
        discoverServerNames().then((found) => {
            if ((found == null || Object.keys(found).length === 0) && attempts < 5) {
                setTimeout(retry, 30000);
            }
        });
    };
    setTimeout(retry, 25000);
}
