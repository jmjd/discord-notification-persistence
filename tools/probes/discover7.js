/*
 * Probe 7 -- the last unknown: can the plugin navigate?
 *
 * transitionTo no longer exists under that name, but the module exposing getHistory() looks
 * like the router internals. If getHistory() returns a normal history object, push() is all
 * the plugin needs.
 *
 * This one ACTUALLY NAVIGATES: it will jump you to #testing in your jmjd server. That is the
 * test. Have something else open first so you can see it move.
 *
 * Paste into DevTools console with BetterDiscord running.
 */
(() => {
    const out = [];
    const say = (s) => out.push(s);
    const W = BdApi.Webpack;
    // Fill these in: turn on Developer Mode (Settings -> Advanced), then right-click a
    // server and a channel in it and choose Copy Server ID / Copy Channel ID.
    const TEST_PATH = '/channels/YOUR_GUILD_ID/YOUR_CHANNEL_ID';

    say('=== 1. The router module ===');
    const Router = W.getByKeys('getHistory', { searchExports: true });
    say('module found: ' + (Router != null));
    if (Router == null) {
        console.log(out.join('\n'));
        return 'no router module';
    }
    say('keys: ' + Object.keys(Router).slice(0, 30).join(', '));
    say('getHistory is a function: ' + (typeof Router.getHistory === 'function'));

    say('');
    say('=== 2. The history object ===');
    let history = null;
    try { history = Router.getHistory(); }
    catch (e) { say('getHistory() threw: ' + e.message); }
    say('history: ' + (history != null ? typeof history : 'null'));
    if (history != null) {
        say('keys: ' + Object.keys(history).slice(0, 30).join(', '));
        for (const k of ['push', 'replace', 'goBack', 'location']) {
            say('  ' + k + ': ' + typeof history[k]);
        }
        try { say('current location: ' + JSON.stringify(history.location?.pathname)); }
        catch { }
    }

    say('');
    say('=== 3. Navigate for real ===');
    if (history != null && typeof history.push === 'function') {
        try {
            history.push(TEST_PATH);
            say('called history.push("' + TEST_PATH + '")');
            setTimeout(() => {
                const now = Router.getHistory()?.location?.pathname;
                console.log('[probe7] pathname after push: ' + now);
                console.log('[probe7] navigation ' + (now === TEST_PATH ? 'WORKED' : 'did not take effect'));
            }, 1200);
            say('watch for a [probe7] line in a second, and see whether Discord jumped to');
            say('#testing in jmjd.');
        }
        catch (e) { say('push threw: ' + e.message); }
    }
    else say('no usable push(); the plugin cannot navigate this way');

    const report = out.join('\n');
    console.log(report);
    try { copy(report); console.log('\n[copied to clipboard]'); } catch { }
    return 'done -- check whether Discord actually moved';
})();
