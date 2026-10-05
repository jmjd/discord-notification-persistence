'use strict';
/*
 * Turns Discord's DevTools on or off, so the console is available for discover.js.
 *
 *   node enable-devtools.js            # enable
 *   node enable-devtools.js --disable  # put it back
 *
 * Discord stable ships with DevTools disabled:
 *
 *   ENABLE_DEVTOOLS = "stable" !== buildInfo.releaseChannel
 *       || settings?.get("DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING", false)
 *
 * Despite the alarming name, the flag only re-enables Chromium's developer tools -- the same
 * ones every browser ships. It is spelled that way because pasting code from strangers into a
 * console is how account tokens get stolen. Only run code you understand there.
 *
 * Discord rewrites settings.json on exit, so an edit made while it is running is lost when you
 * quit. This refuses to touch the file until Discord is closed.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const KEY = 'DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING';
const SETTINGS = path.join(process.env.APPDATA, 'discord', 'settings.json');
const disable = process.argv.includes('--disable');

function discordIsRunning() {
    try {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Discord.exe'], { encoding: 'utf8' });
        return /Discord\.exe/i.test(out);
    }
    catch { return false; }
}

if (discordIsRunning()) {
    console.error('Discord is still running.\n');
    console.error('Quit it completely first -- right-click the tray icon (bottom-right, near the');
    console.error('clock) and choose Quit Discord. Closing the window only hides it.');
    console.error('\nThen run this again. Discord rewrites settings.json as it exits, so editing');
    console.error('now would just have the change overwritten.');
    process.exit(1);
}

if (!fs.existsSync(SETTINGS)) {
    console.error('settings.json not found at ' + SETTINGS);
    process.exit(1);
}

const backup = SETTINGS + '.before-devtools';
const raw = fs.readFileSync(SETTINGS, 'utf8');
const settings = JSON.parse(raw);

if (disable) {
    if (!(KEY in settings)) {
        console.log('DevTools flag is not set; nothing to do.');
        process.exit(0);
    }
    delete settings[KEY];
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
    console.log('DevTools disabled. Start Discord normally.');
    process.exit(0);
}

if (settings[KEY] === true) {
    console.log('DevTools is already enabled. Start Discord and press Ctrl+Shift+I.');
    process.exit(0);
}

if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw);
settings[KEY] = true;
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));

console.log('DevTools enabled (backup: ' + path.basename(backup) + ').');
console.log('');
console.log('Next:');
console.log('  1. Start Discord.');
console.log('  2. Press Ctrl+Shift+I. DevTools opens; click the Console tab.');
console.log('  3. It may warn you about pasting code -- type  allow pasting  if asked.');
console.log('  4. Paste the contents of discover.js, press Enter, and send me the report.');
console.log('     It copies itself to your clipboard.');
console.log('');
console.log('Afterwards:  node enable-devtools.js --disable   (quit Discord first)');
