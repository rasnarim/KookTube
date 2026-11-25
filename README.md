# KookTube Key Detector

On-device key detection for YouTube, YouTube Music, Spotify, SoundCloud, and other music and video sites (Suno, Udio, Radio Javan, Bandcamp, Instagram, TikTok, Facebook, Vimeo, Mixcloud, Audiomack, Twitch, Aparat, and the Internet Archive). Audio stays in the browser. The badge appears at the bottom-right of the player page.

Install it from this folder. The folder you select must contain `manifest.json`.

After you install or update it, reload the extension on the browser’s extensions page, then refresh any player tab that was already open. An open tab keeps the previous audio connection until that refresh.

## Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

## Microsoft Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

## Brave

1. Open `brave://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

## Opera

1. Open `opera://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

## Vivaldi

1. Open `vivaldi://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

Other Chromium browsers use the same steps. Open the browser’s extensions page, turn on developer mode, and load this folder.

## Firefox

Firefox loads this as a temporary add-on. It is removed when Firefox quits, and you load it again the next time.

1. Open `about:debugging`.
2. Click **This Firefox**.
3. Click **Load Temporary Add-on**.
4. Select `manifest.json` inside this folder.

A copy that stays installed after Firefox quits has to be signed through [addons.mozilla.org](https://addons.mozilla.org/).

## Confirm it is running

The extensions page should list **KookTube Key Detector**. Open a player page and refresh that tab. Click the page once. The badge starts in **Western**. Use **−** and **+** to transpose what you hear. Playback speed does not change.

Click the KookTube button in the browser toolbar to turn it off everywhere or only on the current site. In Chrome, pin the button from the puzzle-piece menu first. The button shows **OFF** on tabs where KookTube is off.

Spotify plays most full tracks through an encrypted player. The badge stays visible there and leaves that audio alone, because reading it is not possible without silencing the song. SoundCloud and YouTube use a normal media element, so detection and transpose both run.

## Tests

Run `node test/run.js` for the detection maths and `node test/toggle.js` for the on/off switches.
