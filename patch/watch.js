'use strict';
/*
 * Event-driven alternative to the hourly scheduled task.
 *
 * Discord updates by staging a whole new %LOCALAPPDATA%\Discord\app-<version> folder and
 * then restarting itself into it (via Update.exe --processStart).  This watches the Discord
 * folder and re-applies the patch the moment new module files land -- during the staging
 * window, before the restart -- so Discord never comes back up unpatched.
 *
 * Run it resident:  node watch.js
 * Install at logon: powershell -ExecutionPolicy Bypass -File install-watcher.ps1
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HERE = __dirname;
const PATCH = path.join(HERE, 'patch.js');
const LOG = path.join(HERE, 'watch.log');
const ROOT = path.join(process.env.LOCALAPPDATA, 'Discord');

const DEBOUNCE_MS = 3000;
// An update writes thousands of files; the notifications module may land well after the
// first event, so sweep again a few times before going back to sleep.
const FOLLOW_UP_MS = [15000, 60000, 180000];

function log(line) {
    const entry = new Date().toISOString() + ' ' + line + '\n';
    try { fs.appendFileSync(LOG, entry); } catch { }
}

let running = false;
let queued = false;
function apply(reason) {
    if (running) { queued = true; return; }
    running = true;
    execFile(process.execPath, [PATCH, 'apply'], { cwd: HERE }, (err, stdout, stderr) => {
        running = false;
        const out = String(stdout || '').trim().replace(/\s+/g, ' ');
        if (err) log('apply FAILED (' + reason + '): ' + (stderr || err.message));
        else if (!/Already up to date/.test(out)) log('apply (' + reason + '): ' + out);
        if (queued) { queued = false; apply(reason + '+queued'); }
    });
}

let timer = null;
function schedule(reason) {
    clearTimeout(timer);
    timer = setTimeout(() => {
        apply(reason);
        for (const delay of FOLLOW_UP_MS) setTimeout(() => apply(reason + '+' + delay + 'ms'), delay);
    }, DEBOUNCE_MS);
}

let watcher = null;
function watch() {
    try {
        watcher = fs.watch(ROOT, { recursive: true }, (_event, filename) => {
            // Only care about a new build appearing, not Discord's own cache churn.
            if (filename && /^app-\d/.test(String(filename))) schedule('change:' + String(filename).split(path.sep)[0]);
        });
        watcher.on('error', (err) => {
            log('watcher error, re-establishing: ' + err.message);
            try { watcher.close(); } catch { }
            setTimeout(watch, 10000);
        });
        log('watching ' + ROOT);
    }
    catch (err) {
        log('could not watch ' + ROOT + ' (' + err.message + '), retrying in 60s');
        setTimeout(watch, 60000);
    }
}

log('watcher started (pid ' + process.pid + ')');
apply('startup');
watch();
