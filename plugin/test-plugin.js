'use strict';
/*
 * Tests the plugin outside Discord, with a stubbed BdApi and a fake notification module that
 * mimics the real one: it returns { notification: { close() {...} } } and the caller is
 * responsible for the 5s timer.
 *
 *   node test-plugin.js
 *
 * This cannot cover webpack module discovery -- that only exists inside Discord -- but it does
 * cover every decision the plugin makes.
 */
const path = require('path');

let failures = 0;
function check(name, cond) {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name);
    if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a faithful-enough BdApi.Patcher -------------------------------------------------
function makePatcher() {
    const registry = [];
    return {
        before(id, obj, method, cb) { this._wrap(id, obj, method, cb, 'before'); },
        after(id, obj, method, cb) { this._wrap(id, obj, method, cb, 'after'); },
        _wrap(id, obj, method, cb, kind) {
            let entry = registry.find((e) => e.obj === obj && e.method === method);
            if (!entry) {
                entry = { id, obj, method, original: obj[method], before: [], after: [] };
                registry.push(entry);
                obj[method] = function (...args) {
                    for (const fn of entry.before) fn(this, args);
                    let ret = entry.original.apply(this, args);
                    for (const fn of entry.after) {
                        const replaced = fn(this, args, ret);
                        if (replaced !== undefined) ret = replaced;
                    }
                    return ret;
                };
            }
            entry[kind].push(cb);
        },
        unpatchAll(id) {
            for (const e of registry.filter((x) => x.id === id)) e.obj[e.method] = e.original;
            registry.length = 0;
        },
    };
}

// ---- the fake Discord notification module --------------------------------------------
function makeDiscord() {
    const state = { closes: 0, lastNotification: null, lastTitle: null };
    return {
        state,
        module: {
            showNotification(icon, title, body, trackingProps, options) {
                state.lastTitle = title;
                const n = {
                    close() { state.closes++; },     // stands in for the removal IPC
                };
                state.lastNotification = n;
                // Discord schedules `setTimeout(() => n.close(), 5e3)` here; the tests drive
                // that by hand so they do not have to wait five seconds.
                return Promise.resolve({ notification: n, trackingProps });
            },
        },
    };
}

function makeBridge() {
    const state = { listeners: {}, invoked: [] };
    return {
        state,
        module: {
            focus() { },
            on(channel, cb) { (state.listeners[channel] = state.listeners[channel] || []).push(cb); },
            invoke(channel, payload) {
                state.invoked.push([channel, payload]);
                return Promise.resolve({ identifier: 'id-' + state.invoked.length, delivered: true });
            },
        },
    };
}

function makeRouter() {
    const state = { pushed: [] };
    return { state, module: { getHistory: () => ({ push: (p) => state.pushed.push(p) }) } };
}

function installBdApi(discordModule, guilds, settings, bridge, router) {
    global.BdApi = {
        Patcher: makePatcher(),
        Webpack: {
            getByKeys(...keys) {
                if (keys.includes('showNotification')) return discordModule;
                if (keys.includes('invoke')) return bridge || null;
                if (keys.includes('getHistory')) return router || null;
                if (keys.includes('getGuild')) {
                    return { getGuild: (id) => guilds[id] || null, getGuilds: () => guilds };
                }
                return null;
            },
        },
        Data: { load: () => settings || null, save: () => { } },
        Logger: { info() { }, warn() { }, error() { } },
        UI: { showToast() { } },
    };
}

const PLUGIN = path.join(__dirname, 'NotificationPersistence.plugin.js');
const Plugin = require(PLUGIN);

(async () => {
    // ---- pure helpers ---------------------------------------------------------------
    const rewrite = Plugin.rewriteTitleServer;
    const real = '⁨NotificationFix Hook⁩ (⁨#testing⁩, ⁨Text Channels⁩)';
    check('rewrite: real Discord title, isolates preserved',
        rewrite(real, 'jmjd') === '⁨NotificationFix Hook⁩ (⁨#testing⁩, ⁨jmjd⁩)');
    check('rewrite: title without isolates',
        rewrite('Someone (#general, Text Channels)', 'My Server') === 'Someone (#general, My Server)');
    check('rewrite: channel with no category gets the server appended',
        rewrite('Someone (⁨#general⁩)', 'My Server') === 'Someone (⁨#general⁩, ⁨My Server⁩)');
    check('rewrite: a direct message title is left alone',
        rewrite('Just A Person', 'My Server') === null);
    check('rewrite: a title already naming the server is left alone',
        rewrite('Someone (#general, My Server)', 'My Server') === null);
    check('rewrite: no server name is a no-op', rewrite(real, '') === null);

    const refuse = Plugin.shouldRefuseClose;
    const cfg = { timerWindowMs: 8000 };
    check('rule: close inside the window with no click is refused',
        refuse({ shownAt: 1000, clicked: false }, 6000, cfg) === true);
    check('rule: close after the window is honoured',
        refuse({ shownAt: 1000, clicked: false }, 20000, cfg) === false);
    check('rule: close after a click is honoured',
        refuse({ shownAt: 1000, clicked: true }, 2000, cfg) === false);

    // ---- full patch flow -------------------------------------------------------------
    const guilds = { '111222333444555666': { name: 'jmjd' } };
    const discord = makeDiscord();
    installBdApi(discord.module, guilds, { timerWindowMs: 60, serverName: true, log: false });

    const plugin = new Plugin();
    plugin.start();

    // 1. The auto-clear timer, refused.
    let res = await discord.module.showNotification('icon', real, 'body',
        { guild_id: '111222333444555666', channel_id: 'c1' }, { tag: 'm1' });
    res.notification.close();                      // what Discord's 5s timer does
    check('FLOW: auto-clear within the window is refused', discord.state.closes === 0);
    check('FLOW: the title was rewritten with the server name',
        discord.state.lastTitle === '⁨NotificationFix Hook⁩ (⁨#testing⁩, ⁨jmjd⁩)');

    // 2. A later removal -- Discord clearing something you have read -- is honoured.
    await sleep(100);                              // past the 60ms test window
    res.notification.close();
    check('FLOW: a later removal is honoured', discord.state.closes === 1);

    // 3. A click makes an immediate removal legitimate.
    const options = { tag: 'm2', onClick: () => { options._fired = true; } };
    res = await discord.module.showNotification('icon', real, 'body',
        { guild_id: '111222333444555666' }, options);
    options.onClick();                             // you clicked the toast
    res.notification.close();
    check('FLOW: removal after a click is honoured', discord.state.closes === 2);
    check('FLOW: the original onClick still runs', options._fired === true);

    // 4. A DM has no guild, so the title must be untouched.
    const dmTitle = 'Some Person';
    await discord.module.showNotification('icon', dmTitle, 'body', {}, { tag: 'm3' });
    check('FLOW: a DM title is left alone', discord.state.lastTitle === dmTitle);

    // 5. Concurrent notifications must not share state.
    const oA = { tag: 'a' };
    const oB = { tag: 'b' };
    const rA = await discord.module.showNotification('i', real, 'b', { guild_id: 'x' }, oA);
    const rB = await discord.module.showNotification('i', real, 'b', { guild_id: 'x' }, oB);
    oA.onClick();                                  // only A was clicked
    const before = discord.state.closes;
    rB.notification.close();                       // B: auto-clear, must be refused
    rA.notification.close();                       // A: clicked, must be honoured
    check('FLOW: concurrent notifications keep separate state',
        discord.state.closes === before + 1);

    // 6. Stopping restores stock behaviour completely.
    plugin.stop();
    const after = discord.state.closes;
    res = await discord.module.showNotification('icon', real, 'body',
        { guild_id: '111222333444555666' }, { tag: 'm4' });
    res.notification.close();
    check('FLOW: after stop(), close works normally again', discord.state.closes === after + 1);
    check('FLOW: after stop(), titles are no longer rewritten', discord.state.lastTitle === real);

    // 7. A Discord that no longer has the module must not throw.
    installBdApi(null, guilds, {});
    const orphan = new Plugin();
    let threw = false;
    try { orphan.start(); orphan.stop(); } catch { threw = true; }
    check('FLOW: a missing notification module degrades quietly', threw === false);

    // ---- click revival ---------------------------------------------------------------
    const link = Plugin.deepLinkPath;
    check('deep link: a discord: link yields its in-app path',
        link('discord://-/channels/111/222/333') === '/channels/111/222/333');
    check('deep link: an http link is rejected', link('https://discord.com/channels/1/2') === null);
    check('deep link: rubbish is rejected', link('not a url') === null);
    check('deep link: null is rejected', link(null) === null);

    const nav = Plugin.shouldNavigate;
    const navCfg = { reviveClicks: true };
    check('navigate: only once Discord has forgotten the notification',
        nav({ path: '/p', discordForgot: true }, navCfg) === true);
    check('navigate: not while Discord still has its record',
        nav({ path: '/p', discordForgot: false }, navCfg) === false);
    check('navigate: not without a path', nav({ path: null, discordForgot: true }, navCfg) === false);
    check('navigate: not when the setting is off',
        nav({ path: '/p', discordForgot: true }, { reviveClicks: false }) === false);

    // Full flow: send -> dismissal -> click, with a stubbed bridge and router.
    const discord2 = makeDiscord();
    const bridge = makeBridge();
    const router = makeRouter();
    installBdApi(discord2.module, guilds,
        { timerWindowMs: 60, serverName: true, reviveClicks: true },
        bridge.module, router.module);

    const p2 = new Plugin();
    p2.start();

    const fire = (action, identifier) => {
        for (const cb of bridge.state.listeners.NOTIFICATIONS_RECEIVED_RESPONSE || []) {
            cb({}, action, identifier, '');
        }
    };

    // Discord sends the notification; the plugin records identifier -> deep link.
    await bridge.module.invoke('NOTIFICATIONS_SEND_NOTIFICATION',
        { title: 't', body: 'b', fallbackDeepLink: 'discord://-/channels/111222333444555666/999/888' });
    await sleep(10);

    // A click while Discord still holds its record: the plugin must stay out of the way.
    fire('clicked', 'id-1');
    check('CLICK: no navigation while Discord still has the record', router.state.pushed.length === 0);

    // The dismissal is what makes Discord forget.
    fire('dismiss', 'id-1');
    fire('clicked', 'id-1');
    check('CLICK: navigates once Discord has forgotten',
        router.state.pushed.length === 1
        && router.state.pushed[0] === '/channels/111222333444555666/999/888');

    // An identifier we never saw must be ignored, not guessed at.
    fire('dismiss', 'unknown-id');
    fire('clicked', 'unknown-id');
    check('CLICK: an unknown identifier is ignored', router.state.pushed.length === 1);

    // After stop(), the shared listener must be inert.
    p2.stop();
    fire('clicked', 'id-1');
    check('CLICK: the listener is inert after stop()', router.state.pushed.length === 1);

    console.log(failures === 0 ? '\nAll checks passed.' : '\n' + failures + ' check(s) FAILED.');
    process.exit(failures === 0 ? 0 : 1);
})();
