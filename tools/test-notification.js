'use strict';
/*
 * Triggers a real Discord notification on demand, so you can test the plugin without waiting for
 * someone to message you.
 *
 * Setup (once):
 *   1. In Discord, make a server you own (+ -> Create My Own -> For me and my friends), or use
 *      any existing server where you can edit a channel.
 *   2. Right-click a channel -> Edit Channel -> Integrations -> Webhooks -> New Webhook
 *      -> Copy Webhook URL.
 *   3. Save that URL as webhook.txt next to this script. It stays on disk and is never printed.
 *      Treat it as a secret: anyone holding it can post to that channel. Delete the webhook in
 *      Discord when you are done testing.
 *   4. Make sure the notification will actually fire: either set that channel to All Messages
 *      (right-click channel -> Notification Settings), or save your own user id as mention.txt
 *      (Settings -> Advanced -> Developer Mode, then right-click yourself -> Copy User ID) and
 *      the test message will ping you.
 *
 * Run:
 *   node test-notification.js
 *
 * It waits twelve seconds before posting so you can switch away from Discord. Discord suppresses
 * notifications for the channel you are currently looking at, and that is normal behaviour, not
 * the bug being tested.
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const WEBHOOK = path.join(HERE, 'webhook.txt');
const MENTION = path.join(HERE, 'mention.txt');
const LEAD_MS = 12000;

if (!fs.existsSync(WEBHOOK)) {
    console.error('webhook.txt not found next to this script.\n');
    console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/*')[1].trim());
    process.exit(1);
}
const url = fs.readFileSync(WEBHOOK, 'utf8').trim();
if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url)) {
    console.error('webhook.txt does not look like a Discord webhook URL.');
    process.exit(1);
}
const mention = fs.existsSync(MENTION) ? fs.readFileSync(MENTION, 'utf8').trim() : null;

(async () => {
    console.log('Switch away from Discord now -- minimize it, or focus another window.');
    console.log('Do not sit on the test channel. Posting in ' + (LEAD_MS / 1000) + 's...\n');
    for (let left = LEAD_MS / 1000; left > 0; left--) {
        process.stdout.write('  ' + left + '... ');
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('\n');

    const stamp = new Date().toLocaleTimeString();
    const content = (mention ? '<@' + mention + '> ' : '')
        + 'Notification center test at ' + stamp + ' - leave this one sitting in the center.';

    // ?wait=true returns the created message, which tells us whether the ping resolved.
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'wait=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, allowed_mentions: { parse: ['users'] } }),
    });
    if (!res.ok) {
        console.error('Webhook POST failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
        process.exit(1);
    }

    let posted = null;
    try { posted = await res.json(); } catch { }
    if (mention != null && posted != null && Array.isArray(posted.mentions)) {
        const pinged = posted.mentions.some((u) => u.id === mention);
        console.log(pinged
            ? 'Ping resolved: Discord registered this as a direct mention of you.\n'
            : 'WARNING: the mention did not resolve, so under "Only @mentions" this will not\n'
            + 'notify you. Re-copy your user id, or set the channel to All Messages.\n');
    }

    console.log('Posted. Now check, in order:');
    console.log('');
    console.log('  1. A notification appeared.');
    console.log('     If not, Discord filtered it: check your status is not Do Not Disturb,');
    console.log('     that Settings -> Notifications -> Enable Desktop Notifications is on, and');
    console.log('     that the server and channel are not muted.');
    console.log('');
    console.log('  2. Wait a minute, then open the notification center (Win+N).');
    console.log('     The notification should still be listed. Without the plugin it is gone');
    console.log('     about five seconds after it appeared.');
    console.log('');
    console.log('  3. Its title should name the server, not a channel category');
    console.log('     ("Sender (#channel, My Server)", not "... , Text Channels").');
    console.log('');
    console.log('  4. Click it in the notification center. Discord should come to the front AND');
    console.log('     open that message. Focusing without navigating is the unfixed behaviour.');
})();
