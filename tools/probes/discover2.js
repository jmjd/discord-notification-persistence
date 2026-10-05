/*
 * Follow-up probe. Paste into Discord's DevTools console like the first one.
 *
 * Answers what discover.js left open:
 *   1. Can window.DiscordNative be shadowed? (revives interception point A)
 *   2. The code around the 5s timer in module 675782, to find a patchable seam
 *   3. Which module lb.xi comes from
 *   4. GuildStore, with a much broader search
 *
 * Read-only apart from one assignment test that restores itself immediately.
 */
(() => {
    const out = [];
    const say = (s) => out.push(s);

    say('=== 1. Can DiscordNative itself be shadowed? ===');
    try {
        const d = Object.getOwnPropertyDescriptor(window, 'DiscordNative');
        say('window.DiscordNative descriptor: ' + (d
            ? 'writable=' + d.writable + ' configurable=' + d.configurable + ' hasGetter=' + (d.get != null)
            : 'none (inherited?)'));
        say('Object.isFrozen(DiscordNative): ' + Object.isFrozen(window.DiscordNative));

        const real = window.DiscordNative;
        let stuck = false;
        try {
            const proxy = new Proxy(real, { get: (t, p) => t[p] });
            window.DiscordNative = proxy;
            stuck = window.DiscordNative === proxy;
            window.DiscordNative = real;      // restore immediately
        }
        catch (e) { say('assignment threw: ' + e.message); }
        say('shadowing whole object sticks: ' + stuck);

        // Also: can we redefine just the ipc property on the top-level object?
        let redefined = false;
        try {
            const realIpc = real.ipc;
            Object.defineProperty(real, 'ipc', { value: realIpc, configurable: true, writable: true });
            redefined = true;
        }
        catch (e) { say('defineProperty on .ipc threw: ' + e.message); }
        say('can redefine DiscordNative.ipc: ' + redefined);
    }
    catch (e) { say('probe 1 threw: ' + e.message); }

    say('');
    say('=== 2. The timer in context ===');
    let req = null;
    try {
        const chunk = window.webpackChunkdiscord_app;
        chunk.push([[Symbol('probe2')], {}, (r) => { req = r; }]);
        chunk.pop();
    }
    catch (e) { say('webpack probe threw: ' + e.message); }

    let src = '';
    try {
        src = req.m[675782].toString();
        say('module 675782 length: ' + src.length);
        const i = src.indexOf('5e3');
        say('--- 1200 chars before the timer ---');
        say(src.slice(Math.max(0, i - 1200), i + 200));
        say('--- end ---');
    }
    catch (e) { say('could not read module 675782: ' + e.message); }

    say('');
    say('=== 3. What is lb, and what does it export? ===');
    try {
        // Webpack factories start with a header mapping locals to required module ids.
        const head = src.slice(0, 900);
        say('factory head: ' + head.replace(/\s+/g, ' '));
        // Find requires so we can map the local name (lb) to a module id.
        const requires = [...src.matchAll(/(\w+)\s*=\s*[\w$]+\((\d{3,7})\)/g)].slice(0, 25);
        say('locals -> module ids: ' + requires.map((m) => m[1] + '=' + m[2]).join(', '));
        const lb = requires.find((m) => m[1] === 'lb');
        if (lb) {
            const id = lb[2];
            say('lb is module ' + id);
            const ex = req.c && req.c[id] && req.c[id].exports;
            say('  exports keys: ' + (ex ? Object.keys(ex).slice(0, 40).join(', ') : '<not instantiated>'));
            if (ex && 'xi' in ex) {
                const d = Object.getOwnPropertyDescriptor(ex, 'xi');
                say('  xi descriptor: writable=' + d.writable + ' configurable=' + d.configurable
                    + ' hasGetter=' + (d.get != null));
                say('  xi source: ' + String(ex.xi).slice(0, 400).replace(/\s+/g, ' '));
            }
        }
        else say('lb not found in the require header -- paste the factory head above and I will map it');
    }
    catch (e) { say('probe 3 threw: ' + e.message); }

    say('');
    say('=== 4. GuildStore, broader search ===');
    try {
        let found = null;
        let scanned = 0;
        for (const m of Object.values(req.c || {})) {
            const e = m && m.exports;
            if (!e) continue;
            scanned++;
            const candidates = [e];
            for (const k of Object.keys(e)) {
                try { if (e[k] && typeof e[k] === 'object') candidates.push(e[k]); } catch { }
            }
            for (const c of candidates) {
                try {
                    if (c && typeof c.getGuild === 'function' && typeof c.getGuilds === 'function') {
                        found = c;
                        break;
                    }
                }
                catch { }
            }
            if (found) break;
        }
        say('modules scanned: ' + scanned);
        say('GuildStore found: ' + (found != null));
        if (found) {
            const guilds = found.getGuilds();
            const ids = Object.keys(guilds);
            say('guild count: ' + ids.length);
            // Echo one name only, to prove name resolution works. Yours, not a private one.
            // Replace with one of your own server ids (Developer Mode -> Copy Server ID).
            const sample = guilds['YOUR_GUILD_ID'];
            say('getGuild("YOUR_GUILD_ID").name === ' + (sample ? JSON.stringify(sample.name) : '<not found>'));
        }
    }
    catch (e) { say('probe 4 threw: ' + e.message); }

    const report = out.join('\n');
    console.log(report);
    try { copy(report); console.log('\n[copied to clipboard]'); } catch { }
    return 'done';
})();
