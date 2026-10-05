#!/usr/bin/env node
'use strict';
/*
 * Applies / reverts / reports the Discord notification-center persistence patch.
 *
 * Usage:  node patch.js status
 *         node patch.js apply
 *         node patch.js revert
 *
 * Safe to re-run.  After Discord auto-updates itself into a new app-<version> folder the
 * stock file comes back, so just run `node patch.js apply` again (see install-watcher.ps1 for
 * doing that automatically at logon).
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const WRAPPER_SRC = path.join(HERE, 'wrapper-notifications_win.js');
const CONFIG_PATH = path.join(HERE, 'config.json');
const LOG_PATH = path.join(HERE, 'events.log');
const SERVERS_PATH = path.join(HERE, 'servers.json');
const ARCHIVE_DIR = path.join(HERE, 'stock-history');
const HISTORY_PATH = path.join(HERE, 'stock-history.json');
// Our wrapper is identified by the one line that makes it a wrapper.
const MARKER = "require('./notifications_win.stock.js')";
// The full-copy patch this replaces, so an upgrade can be told apart from a stock file.
const PREVIOUS_MARKER = 'Discord Windows notification persistence fix';

function discordRoot() {
    const base = process.env.LOCALAPPDATA;
    if (!base) throw new Error('LOCALAPPDATA is not set');
    return path.join(base, 'Discord');
}

// Discord keeps every installed build as %LOCALAPPDATA%\Discord\app-<version>.  Module
// updates can also land in %APPDATA%\discord\<version>\modules, which takes precedence when
// present, so both roots are scanned.
function appDirs() {
    const root = discordRoot();
    if (!fs.existsSync(root)) throw new Error('Discord not found at ' + root);
    const found = fs.readdirSync(root)
        .filter((name) => /^app-\d+(\.\d+)*$/.test(name))
        .map((name) => ({ name, dir: path.join(root, name), version: name.slice(4) }));

    const roaming = path.join(process.env.APPDATA || '', 'discord');
    if (fs.existsSync(roaming)) {
        for (const name of fs.readdirSync(roaming)) {
            if (!/^\d+(\.\d+)*$/.test(name)) continue;
            const dir = path.join(roaming, name);
            if (fs.existsSync(path.join(dir, 'modules'))) {
                found.push({ name: 'roaming ' + name, dir, version: name });
            }
        }
    }
    return found.sort((a, b) => {
        const av = a.version.split('.').map(Number);
        const bv = b.version.split('.').map(Number);
        for (let i = 0; i < Math.max(av.length, bv.length); i++) {
            const d = (bv[i] || 0) - (av[i] || 0);
            if (d !== 0) return d;
        }
        return 0;
    });
}

function targetsIn(appDir) {
    const modules = path.join(appDir, 'modules');
    if (!fs.existsSync(modules)) return [];
    return fs.readdirSync(modules)
        .filter((name) => /^discord_notifications-\d+$/.test(name))
        .map((name) => path.join(modules, name, 'discord_notifications', 'notifications_win.js'))
        .filter((file) => fs.existsSync(file));
}

function stockPathFor(file) {
    return path.join(path.dirname(file), 'notifications_win.stock.js');
}

/** 'wrapper' (this version), 'previous' (the older full-copy patch), or 'stock'. */
function stateOf(file) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        if (text.includes(MARKER)) return 'wrapper';
        if (text.includes(PREVIOUS_MARKER)) return 'previous';
        return 'stock';
    }
    catch {
        return 'stock';
    }
}

function ensureConfig() {
    if (fs.existsSync(CONFIG_PATH)) return;
    const cfg = {
        _comment: 'Re-read on every notification (throttled to 2s), so these can be changed without restarting Discord.',
        _mode: '"fix" keeps notifications in the Windows notification center; "observe" restores stock Discord behaviour without re-patching.',
        _timerWindowMs: 'A removal arriving within this long after the toast was shown, with no click from you, is Discord\'s blind auto-clear timer (~5.0s) and is refused.',
        _graceMs: 'Fallback rule for Electron builds that emit an OS close event.',
        _serverName: '"replace" rewrites Discord\'s title, swapping the channel category for the server name; also "attribution", "title", "header", "off".',
        _reviveClicks: 'Re-route a notification center click Discord has already forgotten, by focusing the window and opening the deep link.',
        _discoverServers: 'Read server names off Discord\'s own sidebar ~25s after startup, to fill in servers.json.',
        mode: 'fix',
        timerWindowMs: 8000,
        graceMs: 20000,
        serverName: 'replace',
        reviveClicks: true,
        discoverServers: true,
        log: true,
        logFile: LOG_PATH,
        maxTracked: 300,
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// The wrapper delegates to Discord's module rather than reimplementing it, so Discord changing
// how notifications are built is fine. What it cannot survive is one of the six exports it
// overrides disappearing -- so that, and only that, is what gets checked.
const REQUIRED_EXPORTS = [
    'setCallbacks',
    'getAuthorization',
    'getSettings',
    'sendNotification',
    'removeNotifications',
    'removeAllNotifications',
];
function missingExports(text) {
    return REQUIRED_EXPORTS.filter((name) => !text.includes('exports.' + name));
}

function ensureServers() {
    if (fs.existsSync(SERVERS_PATH)) return;
    fs.writeFileSync(SERVERS_PATH, JSON.stringify({
        _comment: 'Guild id -> server name, used because Discord leaves groupName empty and puts the channel category in the title instead. Ids seen for the first time are appended here with an empty name and a _hint_ showing the notification title they came from; fill in the name and it appears on future notifications. Re-read live, no Discord restart needed.',
    }, null, 2));
}

const force = process.argv.includes('--force');

function apply() {
    ensureConfig();
    ensureServers();
    const esc = (p) => p.split('\\').join('\\\\');
    const wrapper = fs.readFileSync(WRAPPER_SRC, 'utf8')
        .split('__CONFIG_PATH__').join(esc(CONFIG_PATH))
        .split('__LOG_PATH__').join(esc(LOG_PATH))
        .split('__SERVERS_PATH__').join(esc(SERVERS_PATH));

    let count = 0;
    let unchanged = 0;
    let skipped = 0;
    for (const app of appDirs()) {
        for (const file of targetsIn(app.dir)) {
            const stock = stockPathFor(file);
            const current = fs.readFileSync(file, 'utf8');
            const isWrapper = current.includes(MARKER);
            // The earlier version of this patch replaced Discord's module with a full copy of it.
            // That copy must never be mistaken for stock and backed up over the real original --
            // the wrapper would then delegate to it and apply every change twice.
            const isPreviousVersion = !isWrapper && current.includes(PREVIOUS_MARKER);

            if (isWrapper || isPreviousVersion) {
                if (!fs.existsSync(stock)) {
                    console.error('  ! ' + file);
                    console.error('    Already patched, but Discord\'s original is missing from');
                    console.error('    ' + path.basename(stock) + '. Reinstall Discord\'s notifications module');
                    console.error('    (or reinstall Discord) before patching again.');
                    skipped++;
                    continue;
                }
                if (isPreviousVersion) {
                    console.log('  replacing the older full-copy patch, keeping its stock backup');
                }
            }
            else {
                const missing = missingExports(current);
                if (missing.length > 0 && !force) {
                    console.error('  ! ' + file);
                    console.error('    This Discord build\'s notifications module no longer exports: '
                        + missing.join(', ') + '.');
                    console.error('    The wrapper delegates to those, so installing it would break');
                    console.error('    notifications. Skipping. Re-run with --force to override, or check');
                    console.error('    for a newer version of this patch.');
                    skipped++;
                    continue;
                }
                // Only ever back up a genuine stock file.
                fs.copyFileSync(file, stock);
                console.log('  backed up Discord\'s original -> ' + path.basename(stock));
            }
            // Already byte-identical: touch nothing, so the scheduled re-check is a true no-op.
            if (current === wrapper) {
                unchanged++;
                continue;
            }
            fs.writeFileSync(file, wrapper);
            console.log('  patched ' + file);
            count++;
        }
    }
    if (skipped > 0) console.log('\n' + skipped + ' module(s) skipped as unrecognised.');
    if (count === 0 && unchanged === 0) console.log('No notifications module found to patch.');
    else if (count === 0) console.log('Already up to date (' + unchanged + ' module(s), nothing written).');
    else console.log('\nDone. Restart Discord (fully quit from the tray) for it to take effect.');
}

function revert() {
    let count = 0;
    for (const app of appDirs()) {
        for (const file of targetsIn(app.dir)) {
            const stock = stockPathFor(file);
            if (fs.existsSync(stock)) {
                fs.copyFileSync(stock, file);
                fs.unlinkSync(stock);
                console.log('  restored stock ' + file);
                count++;
            }
        }
    }
    if (count === 0) console.log('Nothing to revert.');
    else console.log('\nDone. Restart Discord for it to take effect.');
}

function status() {
    for (const app of appDirs()) {
        console.log(app.name + ':');
        const files = targetsIn(app.dir);
        if (files.length === 0) console.log('  (no notifications module)');
        for (const file of files) {
            const label = { wrapper: 'PATCHED  ', previous: 'OLD PATCH', stock: 'stock    ' }[stateOf(file)];
            console.log('  ' + label + '  ' + file);
        }
    }
    console.log('\nconfig: ' + (fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8').trim() : '(none yet)'));
}

/* ------------------------------------------------------------------ is it still broken? */

/*
 * These answer "has Discord fixed this yet?" for each of the three bugs, by checking for the
 * specific thing that causes it rather than by diffing files. A hash telling you something
 * changed is a chore; "the short callback is still there" is an answer.
 *
 * Only two of the three are checkable on disk. The 5s timer and the isMac() gate live in
 * Discord's renderer bundle, which is fetched from their CDN at runtime and never written to a
 * file -- so the timer is inferred from this patch's own log instead, which is the only place
 * its behaviour is recorded.
 */

/** Looks for `needle` without loading the whole file: ~0.14ms on core.asar vs ~1.06ms. */
function streamContains(file, needle) {
    const CHUNK = 65536;
    let fd;
    try { fd = fs.openSync(file, 'r'); }
    catch { return null; }                       // null means "could not read", not "absent"
    try {
        const buf = Buffer.alloc(CHUNK);
        let carry = '';
        let pos = 0;
        for (;;) {
            const n = fs.readSync(fd, buf, 0, CHUNK, pos);
            if (n <= 0) return false;
            pos += n;
            // The carry keeps a needle's worth of the previous chunk so a match that straddles
            // a chunk boundary is not missed.
            const text = carry + buf.toString('latin1', 0, n);
            if (text.includes(needle)) return true;
            carry = text.slice(-needle.length);
        }
    }
    finally { fs.closeSync(fd); }
}

const SHORT_CALLBACK = 'setCallbacks((action,identifier,userText)=>';
const LONG_CALLBACK = 'setCallbacks((action,identifier,userText,fallbackDeepLink)=>';

/** Bug 3: core.asar's Windows callback drops fallbackDeepLink, so Discord's own fallback dies. */
function probeDeepLinkCallback(appDir) {
    const modules = path.join(appDir, 'modules');
    if (!fs.existsSync(modules)) return { state: 'unknown', detail: 'no modules directory' };
    const core = fs.readdirSync(modules)
        .filter((n) => /^discord_desktop_core-\d+$/.test(n))
        .map((n) => path.join(modules, n, 'discord_desktop_core', 'core.asar'))
        .find((f) => fs.existsSync(f));
    if (core == null) return { state: 'unknown', detail: 'core.asar not found' };

    const short = streamContains(core, SHORT_CALLBACK);
    const long = streamContains(core, LONG_CALLBACK);
    if (short === null) return { state: 'unknown', detail: 'could not read core.asar' };
    if (short) return { state: 'broken', detail: 'the 3-argument callback is still there' };
    if (long) return { state: 'fixed', detail: 'only the 4-argument callback remains' };
    return { state: 'unknown', detail: 'neither callback shape found; core.asar has been restructured' };
}

/** Bug 2, the half that is on disk: supportsHeaders() hardcoded false in the Windows module. */
function probeWindowsHeaders(stockFile) {
    if (!fs.existsSync(stockFile)) return { state: 'unknown', detail: 'no stock file to read' };
    const text = fs.readFileSync(stockFile, 'utf8');
    if (!text.includes('supportsHeaders')) {
        return { state: 'unknown', detail: 'supportsHeaders is gone; the module has been rewritten' };
    }
    if (/supportsHeaders\s*\(\s*\)\s*\{\s*return\s+false/.test(text)) {
        return { state: 'broken', detail: 'supportsHeaders() still returns false' };
    }
    return { state: 'fixed', detail: 'supportsHeaders() no longer returns a hardcoded false' };
}

/**
 * Bug 1: not on disk at all, so this reads our own log. A run of notifications with no refusal
 * is the only evidence available that the timer has stopped firing.
 */
function probeAutoClearTimer(logFile) {
    if (!fs.existsSync(logFile)) return { state: 'unknown', detail: 'no log yet' };
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    let lastRefusal = null;
    let intervalMs = null;
    let sendsSince = 0;
    for (const line of lines) {
        if (line.includes(' remove-refused ')) {
            lastRefusal = line.slice(0, 24);
            const m = /auto-clear timer, (\d+)ms/.exec(line);
            if (m) intervalMs = Number(m[1]);
            sendsSince = 0;
        }
        else if (line.includes(' send ')) sendsSince++;
    }
    if (lastRefusal == null) {
        return {
            state: 'unknown',
            detail: lines.some((l) => l.includes(' send '))
                ? 'notifications were sent but none was ever refused -- is mode set to observe?'
                : 'no notifications recorded yet',
        };
    }
    if (sendsSince >= 5) {
        return {
            state: 'possibly fixed',
            detail: sendsSince + ' notifications since the last refusal (' + lastRefusal
                + '); the timer may have stopped firing',
        };
    }
    return {
        state: 'broken',
        detail: 'last refused ' + lastRefusal + ' at ' + (intervalMs == null ? '?' : intervalMs)
            + 'ms after send',
    };
}

/** Keeps one copy of each distinct stock module, so a change can be diffed rather than guessed. */
function archiveStock(stockFile, version) {
    try {
        const crypto = require('crypto');
        const body = fs.readFileSync(stockFile);
        const hash = crypto.createHash('sha256').update(body).digest('hex');
        let history = {};
        try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch { }
        // Only meaningful once there is something to compare against: the first archive of a
        // fresh install is not a change.
        const hadHistory = Object.keys(history).length > 0;
        const seen = Object.values(history).some((e) => e && e.sha256 === hash);
        history[version] = { sha256: hash, bytes: body.length, firstSeen: new Date().toISOString() };
        fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        fs.writeFileSync(path.join(ARCHIVE_DIR, version + '.js'), body);
        fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
        return { hash: hash.slice(0, 12), changed: hadHistory && !seen, versions: Object.keys(history).length };
    }
    catch (err) {
        return { hash: null, changed: false, error: err.message };
    }
}

function check() {
    const apps = appDirs();
    if (apps.length === 0) {
        console.log('No Discord installation found.');
        return;
    }
    const app = apps[0];
    const target = targetsIn(app.dir)[0];
    const stock = target != null ? stockPathFor(target) : null;

    console.log('Discord ' + app.version + ' -- is each bug still present?\n');
    const results = [
        ['the 5s auto-clear timer', probeAutoClearTimer(LOG_PATH)],
        ['the server name (Windows toast headers)', probeWindowsHeaders(stock)],
        ['the dropped fallbackDeepLink', probeDeepLinkCallback(app.dir)],
    ];
    for (const [name, r] of results) {
        const label = { broken: 'STILL BROKEN  ', fixed: 'FIXED         ',
            'possibly fixed': 'MAYBE FIXED   ', unknown: 'CANNOT TELL   ' }[r.state];
        console.log('  ' + label + name);
        console.log('                ' + r.detail);
    }
    console.log('\nThe timer and the isMac() gate live in Discord\'s renderer bundle, which is');
    console.log('fetched at runtime and never written to disk, so the first line is inferred from');
    console.log('this patch\'s own log. Re-run tools/probes to check the renderer directly.');

    if (stock != null && fs.existsSync(stock)) {
        const a = archiveStock(stock, app.version);
        if (a.hash != null) {
            console.log('\nDiscord\'s module: sha256 ' + a.hash + ', ' + a.versions
                + ' version(s) archived in ' + path.basename(ARCHIVE_DIR) + '/');
            if (a.changed) console.log('  ** this content is new -- worth diffing against the previous copy **');
        }
    }
}

if (require.main === module) {
    const cmd = process.argv[2] || 'status';
    if (cmd === 'apply') apply();
    else if (cmd === 'revert') revert();
    else if (cmd === 'status') status();
    else if (cmd === 'check') check();
    else {
        console.error('Usage: node patch.js [status|apply|revert|check] [--force]');
        process.exit(1);
    }
}

module.exports = {
    streamContains,
    probeDeepLinkCallback,
    probeWindowsHeaders,
    probeAutoClearTimer,
    archiveStock,
};
