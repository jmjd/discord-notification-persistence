/*
 * Probe 5 -- can the plugin fix clicks on its own?
 *
 * The renderer talks to main through a module used as `y.Ay.invoke(...)`, `y.Ay.on(...)`,
 * `y.Ay.focus()`. If that module is findable and its methods are writable, the plugin can:
 *   - patch invoke() to capture each notification's identifier and its fallbackDeepLink
 *   - register its own NOTIFICATIONS_RECEIVED_RESPONSE listener
 *   - navigate itself on a click Discord has forgotten
 *
 * Paste into DevTools console. BetterDiscord must be running (uses BdApi).
 */
(() => {
    const out = [];
    const say = (s) => out.push(s);
    const W = BdApi.Webpack;

    say('=== 1. Find the native bridge module ===');
    const attempts = [
        ['invoke + focus', () => W.getByKeys('invoke', 'focus')],
        ['invoke + on + send', () => W.getByKeys('invoke', 'on', 'send')],
        ['invoke + focus (searchExports)', () => W.getByKeys('invoke', 'focus', { searchExports: true })],
        ['invoke + on (searchExports)', () => W.getByKeys('invoke', 'on', { searchExports: true })],
    ];
    let bridge = null;
    let foundBy = null;
    for (const [label, fn] of attempts) {
        let mod = null;
        try { mod = fn(); } catch (e) { say('  ' + label + ' threw: ' + e.message); continue; }
        say('  ' + label + ': ' + (mod ? 'FOUND -> keys: ' + Object.keys(mod).slice(0, 25).join(', ') : 'no'));
        if (mod && bridge == null) { bridge = mod; foundBy = label; }
    }

    say('');
    say('=== 2. Is it patchable? ===');
    if (bridge == null) say('no bridge module found');
    else {
        say('using: ' + foundBy);
        for (const key of ['invoke', 'on', 'focus']) {
            if (typeof bridge[key] !== 'function') { say('  ' + key + ': not a function'); continue; }
            const d = Object.getOwnPropertyDescriptor(bridge, key);
            let sticks = false;
            const original = bridge[key];
            try {
                bridge[key] = function (...a) { return original.apply(this, a); };
                sticks = bridge[key] !== original;
                bridge[key] = original;               // restore
            }
            catch (e) { say('  ' + key + ' assignment threw: ' + e.message); }
            say('  ' + key + ': writable=' + (d ? d.writable : '?')
                + ' configurable=' + (d ? d.configurable : '?')
                + ' getter=' + (d ? d.get != null : '?')
                + ' assignment sticks=' + sticks);
        }
    }

    say('');
    say('=== 3. Can we listen for notification responses ourselves? ===');
    // If this works, the plugin sees clicks even when Discord has dropped its record.
    if (bridge != null && typeof bridge.on === 'function') {
        try {
            const probe = (...args) => {
                console.log('[probe5] NOTIFICATIONS_RECEIVED_RESPONSE fired with',
                    args.length, 'args:', args.map((a) => typeof a).join(', '));
            };
            bridge.on('NOTIFICATIONS_RECEIVED_RESPONSE', probe);
            say('listener registered OK. Trigger a notification, let it sit, then click it in the');
            say('notification center -- watch the console for a [probe5] line. That tells us both');
            say('that we receive clicks, and how many arguments actually arrive.');
            say('(the listener stays until you reload Discord with Ctrl+R)');
        }
        catch (e) { say('registering a listener threw: ' + e.message); }
    }
    else say('no .on() available');

    say('');
    say('=== 4. Is Discord\'s router reachable for navigation? ===');
    // The fallback path calls (0, u.A)(pathname) -- a transition function.
    for (const [label, keys] of [
        ['transitionTo', ['transitionTo']],
        ['transitionTo + replaceWith', ['transitionTo', 'replaceWith']],
        ['NavigationUtils', ['transitionToGuild']],
    ]) {
        let mod = null;
        try { mod = W.getByKeys(...keys); } catch { }
        say('  ' + label + ': ' + (mod ? 'FOUND -> ' + Object.keys(mod).slice(0, 15).join(', ') : 'no'));
    }

    const report = out.join('\n');
    console.log(report);
    try { copy(report); console.log('\n[copied to clipboard]'); } catch { }
    return 'done -- now trigger a notification and click it from the center';
})();
