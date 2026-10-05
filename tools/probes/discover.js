/*
 * Discovery probe for the BetterDiscord port. Paste into Discord's DevTools console
 * (Ctrl+Shift+I -> Console) and copy the report it prints.
 *
 * BetterDiscord is NOT required to run this.
 *
 * Read-only. It prints shapes, key names, booleans and short excerpts of Discord's own
 * bundled code. It never prints your token, messages, or account data -- the one server name
 * it echoes is one you pass in yourself on the last line.
 */
(() => {
    const out = [];
    const say = (s) => { out.push(s); };
    const shape = (o) => {
        try { return Object.keys(o).slice(0, 40).join(', '); }
        catch { return '<unreadable>'; }
    };

    say('=== 1. DiscordNative ===');
    const DN = window.DiscordNative;
    say('exists: ' + (DN != null) + '   type: ' + typeof DN);
    if (DN != null) {
        say('top-level keys: ' + shape(DN));
        say('notifications key present: ' + ('notifications' in DN));
        for (const k of Object.keys(DN)) {
            if (/notif/i.test(k)) say('  notification-ish namespace "' + k + '": ' + shape(DN[k]));
        }
        if (DN.ipc) say('ipc surface: ' + shape(DN.ipc));
    }

    say('');
    say('=== 2. Is it patchable, or a frozen contextBridge proxy? ===');
    // The decisive question for interception point A.
    const targets = [];
    if (DN) {
        if (DN.notifications) targets.push(['DiscordNative.notifications', DN.notifications]);
        if (DN.ipc) targets.push(['DiscordNative.ipc', DN.ipc]);
    }
    for (const [name, obj] of targets) {
        let frozen = 'unknown';
        let writable = 'unknown';
        try { frozen = String(Object.isFrozen(obj)); } catch { }
        const method = Object.keys(obj).find((k) => typeof obj[k] === 'function');
        if (method) {
            const original = obj[method];
            try {
                obj[method] = function () { return original.apply(this, arguments); };
                writable = String(obj[method] !== original);
                obj[method] = original;   // always restore
            }
            catch (e) { writable = 'threw: ' + e.message; }
        }
        say(name + ' -> frozen=' + frozen + '  assignment sticks=' + writable
            + '  (probed method: ' + (method || 'none') + ')');
    }

    say('');
    say('=== 3. GuildStore ===');
    let req = null;
    try {
        const chunk = window.webpackChunkdiscord_app;
        if (chunk == null) say('webpackChunkdiscord_app: NOT reachable (Discord has hardened it)');
        else {
            chunk.push([[Symbol('probe')], {}, (r) => { req = r; }]);
            chunk.pop();
            say('webpackChunkdiscord_app: reachable, require obtained: ' + (req != null));
        }
    }
    catch (e) { say('webpack probe threw: ' + e.message); }

    let GuildStore = null;
    try {
        if (window.BdApi) {
            GuildStore = BdApi.Webpack.getByKeys('getGuild', 'getGuilds');
            say('via BdApi: ' + (GuildStore != null));
        }
        if (GuildStore == null && req != null) {
            for (const m of Object.values(req.c || {})) {
                const e = m && m.exports;
                for (const candidate of [e, e && e.default, e && e.Z, e && e.ZP]) {
                    if (candidate && typeof candidate.getGuild === 'function'
                        && typeof candidate.getGuilds === 'function') { GuildStore = candidate; break; }
                }
                if (GuildStore) break;
            }
            say('via raw webpack: ' + (GuildStore != null));
        }
        if (GuildStore) {
            const all = GuildStore.getGuilds();
            say('guilds visible: ' + Object.keys(all).length);
        }
    }
    catch (e) { say('GuildStore probe threw: ' + e.message); }

    say('');
    say('=== 4. Who calls the removal? ===');
    const NEEDLE = 'DISCORD_NOTIFICATIONS_REMOVE_NOTIFICATIONS';
    const SEND = 'DISCORD_NOTIFICATIONS_SEND_NOTIFICATION';
    try {
        if (req == null || req.m == null) say('cannot scan module sources (no require cache)');
        else {
            const ids = Object.keys(req.m);
            say('scanning ' + ids.length + ' module factories...');
            let hits = 0;
            for (const id of ids) {
                let src = '';
                try { src = req.m[id].toString(); } catch { continue; }
                if (!src.includes(NEEDLE) && !src.includes(SEND)) continue;
                hits++;
                say('  module ' + id + '  (' + src.length + ' chars)');
                for (const needle of [NEEDLE, SEND]) {
                    const i = src.indexOf(needle);
                    if (i >= 0) say('    ...' + src.slice(Math.max(0, i - 220), i + 160).replace(/\s+/g, ' ') + '...');
                }
                if (hits >= 4) { say('  (stopping after 4 matches)'); break; }
            }
            if (hits === 0) say('  no module references those constants -- the call is built dynamically');
        }
    }
    catch (e) { say('module scan threw: ' + e.message); }

    say('');
    say('=== 5. Timer hunt ===');
    // A 5000ms literal near notification code would be the timer itself.
    try {
        if (req != null && req.m != null) {
            let found = 0;
            for (const id of Object.keys(req.m)) {
                let src = '';
                try { src = req.m[id].toString(); } catch { continue; }
                if (!/notification/i.test(src)) continue;
                const m = /(setTimeout[^;]{0,120}?(5000|5e3))/.exec(src);
                if (m) {
                    say('  module ' + id + ': ' + m[1].replace(/\s+/g, ' ').slice(0, 200));
                    if (++found >= 5) break;
                }
            }
            if (found === 0) say('  no obvious 5000ms timeout in notification-related modules');
        }
    }
    catch (e) { say('timer hunt threw: ' + e.message); }

    const report = out.join('\n');
    console.log(report);
    try { copy(report); console.log('\n[report copied to clipboard]'); } catch { }
    return 'done -- scroll up, or paste the clipboard';
})();
