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

const cmd = process.argv[2] || 'status';
if (cmd === 'apply') apply();
else if (cmd === 'revert') revert();
else if (cmd === 'status') status();
else {
    console.error('Usage: node patch.js [status|apply|revert] [--force]');
    process.exit(1);
}
