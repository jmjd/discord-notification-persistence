/*
 * Third probe -- the last one before a go/no-go decision.
 *
 * discover.js's timer hit was a false positive (a safety-nudge tooltip). This searches on the
 * payload field names our main-process module actually receives, which only the real
 * notification code can contain.
 */
(() => {
    const out = [];
    const say = (s) => out.push(s);
    const flat = (s) => String(s).replace(/\s+/g, ' ');

    let req = null;
    try {
        const chunk = window.webpackChunkdiscord_app;
        chunk.push([[Symbol('probe3')], {}, (r) => { req = r; }]);
        chunk.pop();
    }
    catch (e) { say('webpack probe threw: ' + e.message); }

    say('=== 0. How much can we actually see? ===');
    try {
        say('factories in req.m: ' + Object.keys(req.m || {}).length);
        say('instantiated in req.c: ' + Object.keys(req.c || {}).length);
        say('chunk array length: ' + (window.webpackChunkdiscord_app || []).length);
        const otherRuntimes = Object.keys(window).filter((k) => /^webpackChunk/.test(k));
        say('webpack globals present: ' + otherRuntimes.join(', '));
    }
    catch (e) { say('probe 0 threw: ' + e.message); }

    // The fields our patched notifications_win.js receives. Only the sender can build these.
    const NEEDLES = ['fallbackDeepLink', 'senderDisplayName', 'threadIdentifier'];

    say('');
    say('=== 1. Who builds the notification payload? ===');
    const owners = [];
    try {
        for (const id of Object.keys(req.m || {})) {
            let src = '';
            try { src = req.m[id].toString(); } catch { continue; }
            const hit = NEEDLES.filter((n) => src.includes(n));
            if (hit.length === 0) continue;
            owners.push({ id, src, hit });
        }
        say('modules containing those fields: ' + owners.length);
        for (const o of owners.slice(0, 6)) {
            say('  module ' + o.id + ' (' + o.src.length + ' chars) has: ' + o.hit.join(', '));
        }
    }
    catch (e) { say('probe 1 threw: ' + e.message); }

    say('');
    say('=== 2. The code around it, and any timers in the same module ===');
    try {
        for (const o of owners.slice(0, 3)) {
            say('--- module ' + o.id + ' ---');
            const i = o.src.indexOf(o.hit[0]);
            say('context: ' + flat(o.src.slice(Math.max(0, i - 700), i + 500)));

            const timers = [...o.src.matchAll(/setTimeout\([^;]{0,200}?(\d{3,5}|\de\d)\s*\)/g)].slice(0, 6);
            say('timeouts in this module: ' + (timers.length === 0 ? 'none'
                : timers.map((t) => flat(t[0]).slice(0, 180)).join('  ||  ')));

            // Anything that looks like a removal/close of a notification.
            const removes = [...o.src.matchAll(/[\w$.]{0,30}(remove|close|clear|dismiss)[\w$]{0,25}\([^)]{0,60}\)/gi)].slice(0, 10);
            say('removal-ish calls: ' + removes.map((m) => flat(m[0])).join(', '));
        }
    }
    catch (e) { say('probe 2 threw: ' + e.message); }

    say('');
    say('=== 3. How does the renderer name IPC events? ===');
    try {
        const names = new Set();
        let scanned = 0;
        for (const id of Object.keys(req.m || {})) {
            let src = '';
            try { src = req.m[id].toString(); } catch { continue; }
            if (!src.includes('ipc.invoke') && !src.includes('ipc.send')) continue;
            scanned++;
            for (const m of src.matchAll(/ipc\.(?:invoke|send)\(\s*(["'`])([^"'`]{4,60})\1/g)) names.add(m[2]);
            if (names.size > 60) break;
        }
        say('modules calling ipc.invoke/send: ' + scanned);
        const list = [...names];
        say('literal event names seen (' + list.length + '): ' + list.slice(0, 40).join(', '));
        say('any notification ones: ' + list.filter((n) => /notif/i.test(n)).join(', ') || '(none)');
    }
    catch (e) { say('probe 3 threw: ' + e.message); }

    say('');
    say('=== 4. Are exported bindings patchable at all? ===');
    // Webpack defines exports as non-configurable getters, which would block BdApi.Patcher.
    try {
        const sample = Object.values(req.c || {}).slice(0, 5);
        for (const m of sample) {
            const e = m && m.exports;
            if (!e) continue;
            const key = Object.keys(e)[0];
            if (!key) continue;
            const d = Object.getOwnPropertyDescriptor(e, key);
            say('module exports "' + key + '": writable=' + d.writable
                + ' configurable=' + d.configurable + ' getter=' + (d.get != null));
        }
    }
    catch (e) { say('probe 4 threw: ' + e.message); }

    const report = out.join('\n');
    console.log(report);
    try { copy(report); console.log('\n[copied to clipboard]'); } catch { }
    return 'done';
})();
