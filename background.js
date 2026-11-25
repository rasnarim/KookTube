/*
 * KookTube Key Detector – toolbar button.
 * Each content script reports whether KookTube is on in its tab, and the
 * button shows OFF on tabs where it is switched off. The switches themselves
 * live in popup.html.
 */
'use strict';

const ext = typeof browser !== 'undefined' ? browser : chrome;

ext.action.setBadgeBackgroundColor({ color: '#5a5a5a' });

ext.runtime.onMessage.addListener(function (message, sender) {
  if (!message || message.type !== 'kooktube-state' || !sender || !sender.tab) return;
  const tabId = sender.tab.id;
  ext.action.setBadgeText({ tabId: tabId, text: message.enabled ? '' : 'OFF' });
  ext.action.setTitle({
    tabId: tabId,
    title: message.enabled ? 'KookTube is on here' : 'KookTube is off here',
  });
});
