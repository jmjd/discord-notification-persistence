'use strict';
/*
 * Copies the plugin into BetterDiscord's plugins folder.
 *
 *   node install-plugin.js
 *
 * BD hot-reloads plugins when the file changes, so re-running this after an edit is enough --
 * no Discord restart needed. Enable it once under Settings -> Plugins.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'NotificationPersistence.plugin.js');
const DEST_DIR = path.join(process.env.APPDATA, 'BetterDiscord', 'plugins');
const DEST = path.join(DEST_DIR, 'NotificationPersistence.plugin.js');

if (!fs.existsSync(DEST_DIR)) {
    console.error('BetterDiscord plugins folder not found:\n  ' + DEST_DIR + '\n');
    console.error('Install BetterDiscord first (betterdiscord.app), run it once, then try again.');
    process.exit(1);
}

// Written to a temporary file in the same folder and then renamed over the target, because a
// rename is atomic: BetterDiscord's watcher sees one complete file appear rather than catching a
// partial copy mid-write, which errors and drops the plugin out of its list.
const TEMP = DEST + '.' + process.pid + '.tmp';
fs.writeFileSync(TEMP, fs.readFileSync(SRC));
fs.renameSync(TEMP, DEST);
console.log('Installed -> ' + DEST);
console.log('');
console.log('In Discord: User Settings -> Plugins -> enable "NotificationPersistence".');
console.log('BD hot-reloads on file change, so re-run this after any edit.');
