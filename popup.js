/*
 * KookTube Key Detector – toolbar popup.
 * Writes the same storage keys content.js reads: `globalOff` and
 * `off:<hostname>`. Content scripts pick up the change on their own.
 */
'use strict';

const ext = typeof browser !== 'undefined' ? browser : chrome;
const area = ext.storage.local;
const GLOBAL_OFF_KEY = 'globalOff';

const globalBox = document.getElementById('global');
const siteBox = document.getElementById('site');
const siteRow = document.getElementById('site-row');
const siteName = document.getElementById('site-name');
const note = document.getElementById('note');

let siteKey = null;

function setFlag(key, off) {
  if (off) {
    const items = {};
    items[key] = true;
    return area.set(items);
  }
  return area.remove(key);
}

function render(items) {
  const globalOff = !!items[GLOBAL_OFF_KEY];
  globalBox.checked = !globalOff;
  siteBox.checked = siteKey ? !items[siteKey] : false;
  /* While off everywhere, the site switch is hidden; its own setting is kept for when KookTube is back on. */
  siteRow.hidden = globalOff;
  siteBox.disabled = !siteKey || globalOff;
  siteRow.classList.toggle('disabled', !siteKey);
  if (globalOff) note.textContent = 'Off on every site.';
  else if (!siteKey) note.textContent = 'KookTube is not running in this tab. On a supported site, refresh the tab.';
  else note.textContent = '';
}

function refresh() {
  const keys = siteKey ? [GLOBAL_OFF_KEY, siteKey] : [GLOBAL_OFF_KEY];
  return Promise.resolve(area.get(keys)).then(function (items) {
    render(items || {});
  });
}

function askHost() {
  return Promise.resolve(ext.tabs.query({ active: true, currentWindow: true })).then(function (tabs) {
    const tab = tabs && tabs[0];
    if (!tab || tab.id === undefined) return null;
    return Promise.resolve(ext.tabs.sendMessage(tab.id, { type: 'kooktube-host' })).then(function (reply) {
      return reply && reply.host ? reply.host : null;
    });
  }).catch(function () {
    /* No content script in this tab. */
    return null;
  });
}

globalBox.addEventListener('change', function () {
  setFlag(GLOBAL_OFF_KEY, !globalBox.checked).then(refresh);
});

siteBox.addEventListener('change', function () {
  if (!siteKey) return;
  setFlag(siteKey, !siteBox.checked).then(refresh);
});

askHost().then(function (host) {
  if (host) {
    siteKey = 'off:' + host;
    siteName.textContent = host;
  }
  return refresh();
});
