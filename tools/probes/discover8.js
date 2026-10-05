/*
 * Probe 8 -- can the response listener be removed?
 *
 * The plugin registers a listener on the native bridge that it never removes, because probe 5
 * did not establish whether a removal method exists. That is the weakest part of the plugin:
 * stop() should undo everything, and right now a disabled plugin still has a live closure on
 * every notification response (it returns early, but it runs).
 *
 * This lists the bridge's full key set and looks for anything that unregisters.
 *
 * Paste into DevTools console with BetterDiscord running.
 */
(() => {
    const out = [];
    const say = (s) => out.push(s);

    const bridge = BdApi.Webpack.getByKeys('invoke', 'focus');
    if (bridge == null) {
        console.log('bridge not found');
        return 'bridge not found';
    }

    const keys = Object.keys(bridge);
    say('=== every key on the bridge (' + keys.length + ') ===');
    say(keys.join(', '));

    say('');
    say('=== anything that could unregister a listener ===');
    const candidates = keys.filter((k) => /^(off|un|remove|delete|once|dispose|clear)/i.test(k)
        || /listener|handler|callback/i.test(k));
    say(candidates.length ? candidates.map((k) => '  ' + k + ': ' + typeof bridge[k]).join('\n')
        : '  (none found by name)');

    say('');
    say('=== what `on` actually does ===');
    // If it delegates to an EventEmitter we may be able to reach that emitter instead.
    say(String(bridge.on).replace(/\s+/g, ' ').slice(0, 400));

    say('');
    say('=== is there an emitter hiding on the module? ===');
    for (const k of keys) {
        let v;
        try { v = bridge[k]; } catch { continue; }
        if (v == null || typeof v !== 'object') continue;
        const inner = Object.keys(v).filter((x) => /^(on|off|emit|once|removeListener|addListener)$/.test(x));
        if (inner.length) say('  ' + k + ' -> has ' + inner.join(', '));
    }

    say('');
    say('=== how many listeners does the plugin stack per reload? ===');
    say('Toggle the plugin off and on a few times, then re-run this probe and compare.');
    say('If a count is reachable it will show below.');
    for (const k of ['_events', 'events', 'listeners']) {
        if (bridge[k] != null) {
            try {
                const ev = bridge[k];
                const n = ev['NOTIFICATIONS_RECEIVED_RESPONSE'];
                say('  ' + k + '.NOTIFICATIONS_RECEIVED_RESPONSE: '
                    + (Array.isArray(n) ? n.length + ' listener(s)' : typeof n));
            }
            catch (e) { say('  ' + k + ': ' + e.message); }
        }
    }

    const report = out.join('\n');
    console.log(report);
    try { copy(report); console.log('\n[copied to clipboard]'); } catch { }
    return 'done';
})();
