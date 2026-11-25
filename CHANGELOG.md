# Changelog

## 1.3.0

- A toolbar button opens two switches: **On everywhere** and **On for** the current site. The badge shows only when both are on. Each choice is remembered, and open tabs follow it straight away. The button shows OFF on tabs where KookTube is off.
- While it is off, KookTube does not connect to the player. If it was already connected, transpose returns to 0 and listening stops. Refresh the tab to disconnect fully.
- This needs the `storage` permission, and the browser shows no warning for it.
- `node test/toggle.js` tests the switches, the popup, and the toolbar label.

## 1.2.1

- The same badge also runs on Suno, Udio, Radio Javan, Bandcamp, Instagram, TikTok, Facebook, Vimeo, Mixcloud, Audiomack, Twitch, Aparat, and the Internet Archive. Encrypted players are still left untouched.

## 1.2.0

- The badge also runs on Spotify (`open.spotify.com`) and SoundCloud. A new track clears the buffer. Spotify tracks that use encrypted playback are left untouched, because connecting to them would silence the player.

## 1.1.3

- Transpose control on the badge shifts the music by semitones without changing the video speed. Zero leaves the audio untouched. Key detection still hears the original pitch.

## 1.1.2

- Persian detection prefers a semitone tonic. A sori or koron tonic has to lead by a clear margin, which a real Segah still does and a near miss does not.

## 1.1.1

- Tuning votes are the loud notes in the 10-cent histogram, not every bin above a low floor. A cloud of weak bins from vibrato, the tombak, and off-grid harmonics was pulling the offset to −50¢ and sliding Shur onto a quarter-tone tonic such as B-sori Chahargah.
- Harmonic suppression now runs through the 16th partial, so the 11th and 13th (about 40–50 cents off 12-TET) are removed with the 7th.

## 1.1.0

- Tuning is estimated from a 120-bin (10-cent) histogram instead of assuming A=440. Occupied bins vote equally so a koron drone cannot drag the offset by 50 cents; the amplitude-weighted mean is then taken only inside the winning semitone cluster. The 24-bin chromagram is shifted by that offset, and the badge shows it (for example `tuning −32¢`).
- `foldToTwelve` splits each quarter-tone bin across the two neighbouring semitones.
- Segah is `0, 3, 7, 10, 14, 17, 21` and can sit on a koron tonic such as E-koron. Shur uses a minor 6th. Bayat-e Esfahan is major 2nd, neutral 3rd, perfect 4th and 5th, minor 6th, major 7th.
- Persian templates rotate across all 24 quarter-tone tonics. Off-mode bins are slightly negative so the right pitch set on the wrong tonic scores lower.
- Peaks must clear the local third-octave median by 10 dB and sit within 50 dB of the loudest peak. Magnitudes are compressed, integer harmonics through the 8th are removed, and noisy or silent frames are down-weighted. Auto mode treats only odd bins that persist across recent frames as quarter-tones.
- Auto compares z-scores within each catalog instead of raw Pearson values. The badge shows Low / Medium / High from the gap to the next candidate, not Pearson times 100.
- The extension does not attach to the YouTube video until a user gesture has resumed the audio context, so a suspended context cannot mute playback. It is not suspended while the video is playing.
- Ads (`ad-showing`, `ad-interrupting`) are skipped. The long-term sum decays with a 60-second half-life.
- Frame capture moves to an AudioWorklet, with the AnalyserNode path kept if the worklet cannot load.
- Also matches `music.youtube.com` and YouTube Shorts.
