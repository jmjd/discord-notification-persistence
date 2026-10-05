'use strict';
/*
 * Repairs names in servers.json that an earlier scrape recorded with Discord's unread
 * decorations ("6 mentions, JTF FTJ").  Run it any time the file looks wrong:
 *
 *   node clean-servers.js            # show what it would change
 *   node clean-servers.js --write    # apply
 *
 * Note that discovery overwrites names on every Discord start, so this is a stopgap for the
 * current file -- the real fix is that scraping now reads data-dnd-name and strips unread
 * decorations itself.
 */
const fs = require('fs');
const path = require('path');

const SERVERS_PATH = path.join(__dirname, 'servers.json');
const write = process.argv.includes('--write');

// Same rules as cleanServerName() in the module.
function clean(label) {
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

const map = JSON.parse(fs.readFileSync(SERVERS_PATH, 'utf8'));
const changes = [];
for (const [key, value] of Object.entries(map)) {
    if (key.startsWith('_') || typeof value !== 'string') continue;
    const cleaned = clean(value);
    if (cleaned !== value) {
        changes.push([key, value, cleaned]);
        map[key] = cleaned;
    }
}

// Nothing in the file has trustworthy provenance after a bad scrape, so drop it: every
// current name is then treated as yours and will not be overwritten.
const hadProvenance = map._discovered != null;
delete map._discovered;

for (const [id, from, to] of changes) {
    console.log('  ' + id + '\n    ' + JSON.stringify(from) + '  ->  ' + JSON.stringify(to));
}
console.log('\n' + changes.length + ' name(s) cleaned' + (hadProvenance ? ', provenance reset' : ''));

if (write) {
    fs.writeFileSync(SERVERS_PATH, JSON.stringify(map, null, 2));
    console.log('Written. servers.json is re-read live -- no Discord restart needed.');
}
else {
    console.log('Dry run. Re-run with --write to apply.');
}
