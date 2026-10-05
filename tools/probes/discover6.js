/*
 * Probe 6 -- find Discord's navigation function.
 *
 * Discord's own fallback does:  null != e && (0, u.A)(e)   where e is a discord: pathname.
 * The plugin needs the equivalent. Probe 5 looked for it without searchExports, which is why
 * it found nothing.
 *
 * Paste into DevTools console with BetterDiscord running.
 */
(() => {
    const out = [];
    const say = (s) => out.push(s);
    const W = BdApi.Webpack;
    const keysOf = (m) => { try { return Object.keys(m).slice(0, 20).join(', '); } catch { return '?'; } };

    say('=== Router candidates ===');
    const attempts = [
        ['getByKeys transitionTo (searchExports)', () => W.getByKeys('transitionTo', { searchExports: true })],
        ['getByKeys transitionTo + replaceWith (searchExports)', () => W.getByKeys('transitionTo', 'replaceWith', { searchExports: true })],
        ['getByKeys transitionToGuild (searchExports)', () => W.getByKeys('transitionToGuild', { searchExports: true })],
        ['getByKeys getHistory (searchExports)', () => W.getByKeys('getHistory', { searchExports: true })],
        ['getModule m.transitionTo (searchExports)', () => W.getModule((m) => typeof m?.transitionTo === 'function', { searchExports: true })],
        ['getModule m.default.transitionTo', () => W.getModule((m) => typeof m?.default?.transitionTo === 'function')],
        ['getByKeys transitionTo (plain)', () => W.getByKeys('transitionTo')],
    ];
    const found = [];
    for (const [label, fn] of attempts) {
        let mod = null;
        try { mod = fn(); } catch (e) { say('  ' + label + ' threw: ' + e.message); continue; }
        if (mod == null) { say('  ' + label + ': no'); continue; }
        say('  ' + label + ': FOUND -> ' + keysOf(mod));
        found.push([label, mod]);
    }

    say('');
    say('=== What do the navigation functions look like? ===');
    for (const [label, mod] of found.slice(0, 3)) {
        for (const key of ['transitionTo', 'transitionToGuild', 'replaceWith']) {
            const fn = mod[key] || mod?.default?.[key];
            if (typeof fn !== 'function') continue;
            say('  [' + label + '] ' + key + '(' + fn.length + ' args): '
                + String(fn).replace(/\s+/g, ' ').slice(0, 220));
        }
    }

    say('');
    say('=== Deep-link handler (what the built-in fallback calls) ===');
    // The fallback parses a discord: URL and passes the pathname on. Look for a function that
    // takes a path and routes it.
    const linkAttempts = [
        ['handleDeepLink-ish keys', () => W.getByKeys('handleDeepLink', { searchExports: true })],
        ['openDeepLink-ish keys', () => W.getByKeys('openDeepLink', { searchExports: true })],
        ['transitionToURL', () => W.getByKeys('transitionToURL', { searchExports: true })],
    ];
    for (const [label, fn] of linkAttempts) {
        let mod = null;
        try { mod = fn(); } catch { }
        say('  ' + label + ': ' + (mod ? 'FOUND -> ' + keysOf(mod) : 'no'));
    }

    say('');
    say('=== Reminder ===');
    say('Probe 5 left a listener registered. If you have not already: trigger a notification,');
    say('let it sit past 5s, then click it from the notification center and look for a');
    say('[probe5] line in this console. That confirms the plugin can see forgotten clicks.');
    say('If you have reloaded Discord since, re-run discover5.js first.');

    const report = out.join('\n');
    console.log(report);
    try { copy(report); console.log('\n[copied to clipboard]'); } catch { }
    return 'done';
})();
