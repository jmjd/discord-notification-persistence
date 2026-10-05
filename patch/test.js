'use strict';
/*
 * Tests the wrapper against a fake stock module, in a temporary directory.
 *
 *   node test.js
 *
 * Unlike the previous full-replacement version, this needs no Discord install: the wrapper only
 * talks to Discord's module through six exported functions, so a stand-in that records what it
 * was asked to do covers every decision the wrapper makes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let failures = 0;
function check(name, cond) {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name);
    if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- temp install ---------------------------------------------------------------------
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'notifwrap-'));
const CONFIG = path.join(DIR, 'config.json');
const SERVERS = path.join(DIR, 'servers.json');
const LOG = path.join(DIR, 'events.log');

function writeConfig(over) {
    fs.writeFileSync(CONFIG, JSON.stringify(Object.assign({
        mode: 'fix', timerWindowMs: 300, graceMs: 300, serverName: 'replace',
        reviveClicks: true, clickMode: 'ipc', discoverServers: false, log: true,
        logFile: LOG, maxTracked: 300,
    }, over), null, 2));
}
writeConfig({});
fs.writeFileSync(SERVERS, JSON.stringify({ '111222333444555666': 'Mapped Server' }, null, 2));

// The stand-in for Discord's own module: records calls, hands back identifiers.
fs.writeFileSync(path.join(DIR, 'notifications_win.stock.js'), `
'use strict';
const calls = { sent: [], removed: [], removedAll: 0, callbacks: null, extraArgs: null };
let n = 0;
exports._calls = calls;
exports.setCallbacks = (...args) => { calls.callbacks = args[0]; calls.extraArgs = args.slice(1); };
exports.getAuthorization = () => Promise.resolve('stock-auth');
exports.getSettings = () => Promise.resolve({ authorizationStatus: 'authorized' });
exports.sendNotification = (options) => {
    calls.sent.push(options);
    return Promise.resolve({ identifier: 'id-' + (++n), delivered: true });
};
exports.removeNotifications = (ids) => { calls.removed.push(...ids); return Promise.resolve(); };
exports.removeAllNotifications = () => { calls.removedAll++; return Promise.resolve(); };
`);

const esc = (p) => p.split('\\').join('\\\\');
const wrapper = fs.readFileSync(path.join(__dirname, 'wrapper-notifications_win.js'), 'utf8')
    .split('__CONFIG_PATH__').join(esc(CONFIG))
    .split('__SERVERS_PATH__').join(esc(SERVERS))
    .split('__LOG_PATH__').join(esc(LOG));
const TARGET = path.join(DIR, 'notifications_win.js');
fs.writeFileSync(TARGET, wrapper);

// ---- stub electron -------------------------------------------------------------------
const sent = [];
const fakeWindow = {
    isDestroyed: () => false, isMinimized: () => false, restore() { }, show() { }, focus() { },
    getBounds: () => ({ width: 1200 }),
    webContents: { isLoading: () => false, send: (...a) => sent.push(a), executeJavaScript: () => Promise.resolve({}) },
};
const opened = [];
const realLoad = Module._load;
Module._load = function (request) {
    if (request === 'electron') {
        return {
            BrowserWindow: { getAllWindows: () => [fakeWindow] },
            shell: { openExternal: (u) => opened.push(u) },
        };
    }
    return realLoad.apply(this, arguments);
};

const mod = require(TARGET);
const stock = require(path.join(DIR, 'notifications_win.stock.js'));
const calls = stock._calls;

const REAL_TITLE = '\u2068Someone\u2069 (\u2068#testing\u2069, \u2068Text Channels\u2069)';
const LINK = 'discord://-/channels/111222333444555666/999/888';

(async () => {
    try {
        // ---- pure helpers -----------------------------------------------------------
        check('rewrite: real Discord title keeps its isolates',
            mod.rewriteTitleServer(REAL_TITLE, 'My Server') === '\u2068Someone\u2069 (\u2068#testing\u2069, \u2068My Server\u2069)');
        check('rewrite: a direct message title is left alone',
            mod.rewriteTitleServer('Just A Person', 'My Server') === null);
        check('clean: unread decorations stripped from a scraped name',
            mod.cleanServerName('6 mentions, JTF FTJ') === 'JTF FTJ');
        check('retain: inside the window with no click is refused',
            mod.retainReason({ sentAt: 1000, clickedAt: null, closedAt: null }, 1200) != null);
        check('retain: after the window is honoured',
            mod.retainReason({ sentAt: 1000, clickedAt: null, closedAt: null }, 9000) === null);
        check('retain: after a click is honoured',
            mod.retainReason({ sentAt: 1000, clickedAt: 1100, closedAt: null }, 1200) === null);

        // config.json is hand-edited, so a typo must fall back rather than silently switch the
        // whole fix off. Both of these would otherwise leave the module loaded and inert.
        const clean = mod.sanitizeConfig;
        check('settings: a misspelled mode falls back to "fix", not to doing nothing',
            clean({ mode: 'fxi' }).mode === 'fix');
        check('settings: a valid mode is kept', clean({ mode: 'observe' }).mode === 'observe');
        check('settings: a garbage window falls back instead of poisoning the comparison',
            clean({ timerWindowMs: 'soon' }).timerWindowMs === 8000);
        check('settings: a NaN window falls back', clean({ timerWindowMs: NaN }).timerWindowMs === 8000);
        check('settings: a numeric string window is accepted',
            clean({ timerWindowMs: '2500' }).timerWindowMs === 2500);
        check('settings: an unknown serverName mode falls back to "replace"',
            clean({ serverName: 'attribution' }).serverName === 'replace');
        check('settings: an unknown clickMode falls back to "ipc"',
            clean({ clickMode: 'carrier-pigeon' }).clickMode === 'ipc');
        check('settings: a non-boolean flag falls back',
            clean({ reviveClicks: 'yes' }).reviveClicks === true);
        check('settings: a real boolean flag is kept', clean({ log: false }).log === false);
        check('settings: unknown keys are not carried through',
            clean({ nonsense: 1 }).nonsense === undefined);

        // ---- delegation --------------------------------------------------------------
        check('delegates getAuthorization to Discord\'s module',
            (await mod.getAuthorization()) === 'stock-auth');
        check('delegates getSettings to Discord\'s module',
            (await mod.getSettings()).authorizationStatus === 'authorized');

        const appActions = [];
        const appCallback = (action, id) => appActions.push(action + ':' + id);
        mod.setCallbacks(appCallback, 'extra1', 'extra2');
        // Asserting "is a function" would pass even if the app's own callback were handed
        // straight through, which is the failure this is meant to catch.
        check('setCallbacks installs our handler with Discord, not the app\'s',
            typeof calls.callbacks === 'function' && calls.callbacks !== appCallback);
        check('setCallbacks forwards any further callbacks untouched',
            calls.extraArgs.length === 2 && calls.extraArgs[0] === 'extra1');

        // ---- send + title rewrite ----------------------------------------------------
        // Held as a variable so the object Discord's caller owns can be inspected afterwards.
        const firstOptions = { title: REAL_TITLE, body: 'hi', fallbackDeepLink: LINK };
        const a = await mod.sendNotification(firstOptions);
        check('send delegates and returns Discord\'s identifier', a.identifier === 'id-1');
        check('the server name from servers.json replaces the category',
            calls.sent[0].title === '\u2068Someone\u2069 (\u2068#testing\u2069, \u2068Mapped Server\u2069)');
        // The caller's object must come back untouched: the rewrite goes to a copy, because
        // Discord's renderer keeps using that object after the call.
        check('the caller\'s options object is not mutated', firstOptions.title === REAL_TITLE);
        check('the rewrite went to a copy, not the original',
            calls.sent[0] !== firstOptions && calls.sent[0].body === firstOptions.body);

        // ---- the bug: the auto-clear timer ------------------------------------------
        await mod.removeNotifications([a.identifier]);
        check('CASE 1 the auto-clear removal never reaches Discord\'s module',
            calls.removed.length === 0);

        // ---- a later removal is real ------------------------------------------------
        await sleep(400);
        await mod.removeNotifications([a.identifier]);
        check('CASE 2 a later removal is passed through',
            calls.removed.length === 1 && calls.removed[0] === 'id-1');

        // ---- a click makes removal legitimate ---------------------------------------
        const b = await mod.sendNotification({ title: REAL_TITLE, body: 'hi', fallbackDeepLink: LINK });
        calls.callbacks('clicked', b.identifier, '');
        await mod.removeNotifications([b.identifier]);
        check('CASE 3 removal after a click is passed through', calls.removed.includes('id-2'));
        check('CASE 3 the app still sees the click', appActions.includes('clicked:id-2'));

        // ---- OS dismissal echo ------------------------------------------------------
        const c = await mod.sendNotification({ title: REAL_TITLE, body: 'hi', fallbackDeepLink: LINK });
        await sleep(400);                       // past the timer window
        calls.callbacks('dismiss', c.identifier, '');
        await mod.removeNotifications([c.identifier]);
        check('CASE 4 a removal echoing an OS dismissal is refused', !calls.removed.includes('id-3'));
        check('CASE 4 the app still sees the dismissal', appActions.includes('dismiss:id-3'));

        // ---- click revival ----------------------------------------------------------
        calls.callbacks('clicked', c.identifier, 'arg');
        check('CASE 5 a click Discord has forgotten re-sends the response with the deep link',
            sent.length === 1 && sent[0][0] === 'DISCORD_NOTIFICATIONS_RECEIVED_RESPONSE'
            && sent[0][1] === 'clicked' && sent[0][2] === 'id-3' && sent[0][4] === LINK);
        check('CASE 5 the protocol handler is not used in ipc mode', opened.length === 0);

        const d = await mod.sendNotification({ title: REAL_TITLE, body: 'hi', fallbackDeepLink: LINK });
        calls.callbacks('clicked', d.identifier, '');
        check('CASE 6 a click Discord can still handle is left alone', sent.length === 1);

        // ---- blanket clear ----------------------------------------------------------
        // Two notifications, one past the timer window and one inside it, so the sweep has to
        // make a decision per notification rather than all-or-nothing. Asserting only that the
        // removed list grew would prove nothing: it never shrinks.
        const old = await mod.sendNotification({ title: REAL_TITLE, body: 'old', fallbackDeepLink: LINK });
        await sleep(400);                                   // `old` is now outside the window
        const fresh = await mod.sendNotification({ title: REAL_TITLE, body: 'fresh', fallbackDeepLink: LINK });
        await mod.removeAllNotifications();
        check('CASE 7 removeAll keeps a notification still inside the timer window',
            !calls.removed.includes(fresh.identifier));
        check('CASE 7 removeAll does clear one that is past the window',
            calls.removed.includes(old.identifier));
        check('CASE 7 removeAll never delegates Discord\'s blanket clear',
            calls.removedAll === 0);

        // ---- identifiers we never saw ------------------------------------------------
        await mod.removeNotifications(['never-seen']);
        check('CASE 8 an unknown identifier is passed straight through',
            calls.removed.includes('never-seen'));

        // ---- an unmapped guild gets recorded for labelling ---------------------------
        await mod.sendNotification({
            title: REAL_TITLE, body: 'hi',
            fallbackDeepLink: 'discord://-/channels/777888999000111222/1/2',
        });
        const map = JSON.parse(fs.readFileSync(SERVERS, 'utf8'));
        check('CASE 9 an unseen guild id is appended for labelling',
            map['777888999000111222'] === '' && typeof map['_hint_777888999000111222'] === 'string');

        // ---- title modes -------------------------------------------------------------
        writeConfig({ serverName: 'title' });
        await sleep(2100);
        await mod.sendNotification({ title: REAL_TITLE, body: 'hi', fallbackDeepLink: LINK });
        check('CASE 10 "title" mode appends the server instead of replacing',
            calls.sent[calls.sent.length - 1].title.endsWith('• Mapped Server'));

        writeConfig({ serverName: 'off' });
        await sleep(2100);
        await mod.sendNotification({ title: REAL_TITLE, body: 'hi', fallbackDeepLink: LINK });
        check('CASE 11 "off" leaves the title exactly as Discord built it',
            calls.sent[calls.sent.length - 1].title === REAL_TITLE);

        // ---- observe mode ------------------------------------------------------------
        writeConfig({ mode: 'observe', serverName: 'replace' });
        await sleep(2100);
        const f = await mod.sendNotification({ title: REAL_TITLE, body: 'hi', fallbackDeepLink: LINK });
        await mod.removeNotifications([f.identifier]);
        check('CASE 12 observe mode passes every removal through',
            calls.removed.includes(f.identifier));

        // ---- the validation is actually wired in --------------------------------------
        // Testing sanitizeConfig on its own proves nothing if the load path bypasses it, so this
        // writes a genuinely broken config and checks the behaviour that depends on it. Without
        // sanitizing, mode "fxi" makes retainReason return null and every removal goes through.
        fs.writeFileSync(CONFIG, JSON.stringify({
            mode: 'fxi', timerWindowMs: 'soon', logFile: LOG, log: true,
        }, null, 2));
        await sleep(2100);
        const g = await mod.sendNotification({ title: REAL_TITLE, body: 'bad config', fallbackDeepLink: LINK });
        const removedBeforeBadConfig = calls.removed.length;
        await mod.removeNotifications([g.identifier]);
        check('CASE 13 a broken config falls back to refusing, not to doing nothing',
            calls.removed.length === removedBeforeBadConfig);
        writeConfig({});
        await sleep(2100);

        // ---- the log is diagnosable ---------------------------------------------------
        const logText = fs.readFileSync(LOG, 'utf8');
        check('the log names the wrapper and the reason for each refusal',
            /wrapper mode=/.test(logText) && /auto-clear timer/.test(logText)
            && /echo of OS dismissal/.test(logText));
        check('the log reports which title rewrite was applied',
            /titleMode=replace/.test(logText) && /titleMode=off/.test(logText));

        console.log(failures === 0 ? '\nAll checks passed.' : '\n' + failures + ' check(s) FAILED.');
    }
    catch (err) {
        failures++;
        console.error('\nTHREW: ' + (err && err.stack ? err.stack : err));
    }
    finally {
        fs.rmSync(DIR, { recursive: true, force: true });
        process.exit(failures === 0 ? 0 : 1);
    }
})();
