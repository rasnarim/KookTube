'use strict';

/*
 * On/off switch tests: the storage rule in content.js, the popup, and the
 * toolbar label in background.js. The browser APIs and the popup DOM are
 * small fakes, so this runs in plain Node like run.js.
 */

const path = require('path');
const api = require('../content.js');

let failed = 0;
let passed = 0;

function assertCase(name, ok, detail) {
  if (ok) {
    passed++;
    return;
  }
  failed++;
  console.error('FAIL', name, detail === undefined ? '' : detail);
}

function fakeStorage(initial) {
  const data = Object.assign({}, initial);
  return {
    data: data,
    get: function (keys) {
      const out = {};
      [].concat(keys).forEach(function (key) {
        if (key in data) out[key] = data[key];
      });
      return Promise.resolve(out);
    },
    set: function (items) {
      Object.assign(data, items);
      return Promise.resolve();
    },
    remove: function (key) {
      delete data[key];
      return Promise.resolve();
    },
  };
}

function fakeElement() {
  const listeners = {};
  const classes = new Set();
  return {
    checked: false,
    disabled: false,
    hidden: false,
    textContent: '',
    classList: {
      toggle: function (name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains: function (name) { return classes.has(name); },
    },
    addEventListener: function (type, fn) { listeners[type] = fn; },
    fire: function (type) { return listeners[type](); },
  };
}

function settle() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function loadFresh(file) {
  const full = path.join(__dirname, '..', file);
  delete require.cache[require.resolve(full)];
  require(full);
}

/* ---- storage rule shared by content.js and popup.js ---- */

function ruleTests() {
  const host = 'www.youtube.com';
  assertCase('nothing stored: on', api.siteEnabled({}, host) === true);
  assertCase('no items object: on', api.siteEnabled(undefined, host) === true);
  assertCase('global off: off', api.siteEnabled({ globalOff: true }, host) === false);
  assertCase('this site off: off', api.siteEnabled({ 'off:www.youtube.com': true }, host) === false);
  assertCase('other site off: on', api.siteEnabled({ 'off:soundcloud.com': true }, host) === true);
  assertCase('both off: off', api.siteEnabled({ globalOff: true, 'off:www.youtube.com': true }, host) === false);
  assertCase('removed key (undefined) counts as on', api.siteEnabled({ globalOff: undefined }, host) === true);
  assertCase('site key format', api.siteOffKey('music.youtube.com') === 'off:music.youtube.com');
  assertCase('global key name', api.GLOBAL_OFF_KEY === 'globalOff');
}

/* ---- popup.js ---- */

function setupPopup(storage, host) {
  const els = {
    global: fakeElement(),
    site: fakeElement(),
    'site-row': fakeElement(),
    'site-name': fakeElement(),
    note: fakeElement(),
  };
  global.document = { getElementById: function (id) { return els[id]; } };
  global.chrome = {
    storage: { local: storage },
    tabs: {
      query: function () { return Promise.resolve([{ id: 7 }]); },
      sendMessage: function (tabId, message) {
        if (!host) return Promise.reject(new Error('Receiving end does not exist.'));
        if (tabId !== 7 || message.type !== 'kooktube-host') return Promise.resolve(undefined);
        return Promise.resolve({ host: host });
      },
    },
  };
  loadFresh('popup.js');
  return els;
}

async function popupTests() {
  {
    const storage = fakeStorage({});
    const els = setupPopup(storage, 'www.youtube.com');
    await settle();
    assertCase('popup: fresh install shows both on', els.global.checked && els.site.checked);
    assertCase('popup: site switch usable', !els.site.disabled);
    assertCase('popup: shows hostname', els['site-name'].textContent === 'www.youtube.com');

    els.site.checked = false;
    els.site.fire('change');
    await settle();
    assertCase('popup: site off writes off:<host>', storage.data['off:www.youtube.com'] === true, storage.data);
    assertCase('popup: content rule agrees site is off', !api.siteEnabled(storage.data, 'www.youtube.com'));
    assertCase('popup: other sites unaffected', api.siteEnabled(storage.data, 'soundcloud.com'));

    els.site.checked = true;
    els.site.fire('change');
    await settle();
    assertCase('popup: site on removes key', !('off:www.youtube.com' in storage.data), storage.data);

    els.global.checked = false;
    els.global.fire('change');
    await settle();
    assertCase('popup: global off writes globalOff', storage.data.globalOff === true, storage.data);
    assertCase('popup: site switch hidden while global off', els['site-row'].hidden && els.site.disabled);
    assertCase('popup: site setting kept while global off', els.site.checked && !('off:www.youtube.com' in storage.data));
    assertCase('popup: content rule agrees everything is off', !api.siteEnabled(storage.data, 'soundcloud.com'));

    els.global.checked = true;
    els.global.fire('change');
    await settle();
    assertCase('popup: global on removes key', !('globalOff' in storage.data), storage.data);
    assertCase('popup: site switch shown and usable again', !els['site-row'].hidden && !els.site.disabled && els.site.checked);
    assertCase('popup: site is on again after global on', api.siteEnabled(storage.data, 'www.youtube.com'));
  }

  {
    const storage = fakeStorage({ globalOff: true, 'off:soundcloud.com': true });
    const els = setupPopup(storage, 'soundcloud.com');
    await settle();
    assertCase('popup: reflects stored global off', !els.global.checked);
    assertCase('popup: reflects stored site off', !els.site.checked);
    assertCase('popup: explains global off', /every site/.test(els.note.textContent), els.note.textContent);
    assertCase('popup: site row hidden when stored global off', els['site-row'].hidden);
  }

  {
    const storage = fakeStorage({});
    const els = setupPopup(storage, null);
    await settle();
    assertCase('popup: unsupported page disables site switch', els.site.disabled);
    assertCase('popup: unsupported page explains why', /not running in this tab/.test(els.note.textContent), els.note.textContent);
    assertCase('popup: global switch still works there', els.global.checked && !els.global.disabled);
  }
}

/* ---- background.js ---- */

function backgroundTests() {
  const calls = [];
  let listener = null;
  global.chrome = {
    action: {
      setBadgeBackgroundColor: function () {},
      setBadgeText: function (details) { calls.push(['badge', details.tabId, details.text]); },
      setTitle: function (details) { calls.push(['title', details.tabId, details.title]); },
    },
    runtime: {
      onMessage: { addListener: function (fn) { listener = fn; } },
    },
  };
  loadFresh('background.js');
  assertCase('background: registers a message listener', typeof listener === 'function');

  listener({ type: 'kooktube-state', enabled: false }, { tab: { id: 3 } });
  assertCase('background: off shows OFF on that tab', calls.some(function (c) {
    return c[0] === 'badge' && c[1] === 3 && c[2] === 'OFF';
  }), calls);

  listener({ type: 'kooktube-state', enabled: true }, { tab: { id: 3 } });
  assertCase('background: on clears the label', calls[calls.length - 2][2] === '', calls);

  const before = calls.length;
  listener({ type: 'kooktube-state', enabled: false }, {});
  listener({ type: 'something-else', enabled: false }, { tab: { id: 3 } });
  listener(null, { tab: { id: 3 } });
  assertCase('background: ignores messages without a tab or of other types', calls.length === before, calls);
}

(async function main() {
  ruleTests();
  await popupTests();
  backgroundTests();
  delete global.chrome;
  delete global.document;
  console.log(failed ? failed + ' FAILED, ' + passed + ' passed' : 'ALL ' + passed + ' TOGGLE TESTS PASSED');
  process.exit(failed ? 1 : 0);
})();
