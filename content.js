/*
 * KookTube Key Detector
 * Offline key / dastgah detector for YouTube, Spotify, and SoundCloud.
 *
 * Load unpacked: chrome://extensions → Developer mode → Load unpacked
 * and select this folder. Firefox: about:debugging → Load Temporary Add-on.
 *
 * Audio never leaves the browser. Pitch math is exported for Node tests.
 */
(function (factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') api.boot();
})(function () {
  'use strict';

  const FFT_SIZE = 32768;
  const F_MIN = 65;
  const F_MAX = 2093;
  const HOP_SEC = 0.2;
  const WARMUP_SEC = 5;
  const HALF_LIFE_SEC = 60;
  const FINE_BINS = 120;
  const PROMINENCE_DB = 10;
  const PEAK_RANGE_DB = 50;
  const HARMONIC_CENTS = 20;
  /*
   * Re-tuned on the synthetic suite (48 kHz, 32768-point Blackman FFT).
   * C major, the same progression with partials 1–16, and that progression
   * plus white noise all stay at an odd-bin share of 0.02 or less, with the
   * loudest odd peak at most 0.04 of the loudest even peak. C Mahur, which
   * has no koron, lands at share 0.041 and peak ratio 0.08. The weakest real
   * dastgahs in the suite are Shur and Bayat-e Esfahan (one neutral degree):
   * share 0.15–0.17, peak ratio at least 0.38. Homayoun and Chahargah sit
   * near share 0.25 and peak ratio 0.32.
   * QUARTER_RATIO_MIN 0.06 is above Mahur and the noise case, and below Shur.
   * QUARTER_PEAK_MIN 0.22 is above Mahur's 0.08, and below Homayoun's 0.32.
   * PERSIST_MIN 0.1: an odd bin counts only when it holds at least this
   * fraction of the recent tonal frames (~8 s). A koron that the melody
   * keeps returning to clears it; one noisy frame does not.
   */
  const QUARTER_RATIO_MIN = 0.06;
  const QUARTER_PEAK_MIN = 0.22;
  const PERSIST_MIN = 0.1;
  const PERSIST_SHARE = 0.045;
  const RECENT_FRAMES = 40;
  const HOLD_MARGIN = 0.035;
  const CONF_HIGH = 0.08;
  const CONF_MED = 0.035;

  const A4 = 440;
  const C4 = A4 * Math.pow(2, -9 / 12);

  /** 24-TET pitch classes, 50 cents apart. Index 0 is C. Even indexes are 12-TET. */
  const PC24_NAMES = [
    'C', 'C-sori', 'C#/Db', 'D-koron', 'D', 'D-sori', 'Eb', 'E-koron',
    'E', 'E-sori', 'F', 'F-sori', 'F#', 'G-koron', 'G', 'G-sori',
    'Ab', 'A-koron', 'A', 'A-sori', 'Bb', 'B-koron', 'B', 'B-sori',
  ];

  const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  /*
   * Krumhansl–Kessler probe-tone ratings (Krumhansl & Kessler 1982),
   * used by the Krumhansl–Schmuckler key-finding algorithm. Index 0 is the tonic.
   */
  const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  /*
   * Persian templates: quarter-tone steps above the tonic, with a role.
   * Weights follow the Krumhansl–Schmuckler rank order, not a new probe-tone
   * study: tonic 6.35, fifth 5.19, fourth 4.38, characteristic koron / shahed
   * 4.9, other degrees 3.3. Mahur copies the major-profile values on its
   * scale degrees. Bins outside the mode are −0.75 so the right pitch set on
   * the wrong tonic, where notes fall off the template, scores lower.
   *
   * Shur            2nd koron, minor 3rd, 4th, 5th, minor 6th, minor 7th
   *                 (G Shur: G, A-koron, Bb, C, D, Eb, F)
   * Homayoun        2nd koron, major 3rd, 4th, 5th, 6th koron, minor 7th
   * Chahargah       2nd koron, major 3rd, 4th, 5th, 6th koron, major 7th
   * Segah           koron tonic, then +3, +7, +10, +14, +17, +21
   *                 (E-koron Segah: E-koron, F, G, A-koron, B-koron, C, D)
   * Dashti          minor 2nd, minor 3rd, 4th, 5th, minor 6th, minor 7th
   * Mahur           major scale (same pitch classes as 12-TET major)
   * Bayat-e Esfahan major 2nd, neutral 3rd, 4th, 5th, minor 6th, major 7th
   */
  const W_TONIC = 6.35;
  const W_FIFTH = 5.19;
  const W_FOURTH = 4.38;
  const W_COLOR = 4.9;
  const W_DEGREE = 3.3;
  const W_OFF = -0.75;

  const PERSIAN_MODES = [
    {
      id: 'shur',
      name: 'Shur',
      steps: [
        { step: 0, weight: W_TONIC, role: 'tonic' },
        { step: 3, weight: W_COLOR, role: 'color' },
        { step: 6, weight: W_DEGREE, role: 'degree' },
        { step: 10, weight: W_FOURTH, role: 'fourth' },
        { step: 14, weight: W_FIFTH, role: 'fifth' },
        { step: 16, weight: W_DEGREE, role: 'degree' },
        { step: 20, weight: W_DEGREE, role: 'degree' },
      ],
    },
    {
      id: 'homayoun',
      name: 'Homayoun',
      steps: [
        { step: 0, weight: W_TONIC, role: 'tonic' },
        { step: 3, weight: W_COLOR, role: 'color' },
        { step: 8, weight: 4.7, role: 'color' },
        { step: 10, weight: W_FOURTH, role: 'fourth' },
        { step: 14, weight: W_FIFTH, role: 'fifth' },
        { step: 17, weight: 4.6, role: 'color' },
        { step: 20, weight: W_DEGREE, role: 'degree' },
      ],
    },
    {
      id: 'chahargah',
      name: 'Chahargah',
      steps: [
        { step: 0, weight: W_TONIC, role: 'tonic' },
        { step: 3, weight: W_COLOR, role: 'color' },
        { step: 8, weight: 4.6, role: 'color' },
        { step: 10, weight: W_FOURTH, role: 'fourth' },
        { step: 14, weight: W_FIFTH, role: 'fifth' },
        { step: 17, weight: 4.6, role: 'color' },
        { step: 22, weight: 4.2, role: 'degree' },
      ],
    },
    {
      id: 'segah',
      name: 'Segah',
      steps: [
        { step: 0, weight: W_TONIC, role: 'tonic' },
        { step: 3, weight: 3.4, role: 'degree' },
        { step: 7, weight: W_COLOR, role: 'color' },
        { step: 10, weight: 4.5, role: 'fourth' },
        { step: 14, weight: W_FIFTH, role: 'fifth' },
        { step: 17, weight: 4.4, role: 'color' },
        { step: 21, weight: 3.6, role: 'degree' },
      ],
    },
    {
      id: 'dashti',
      name: 'Dashti',
      steps: [
        { step: 0, weight: W_TONIC, role: 'tonic' },
        { step: 2, weight: W_COLOR, role: 'color' },
        { step: 6, weight: 4.2, role: 'degree' },
        { step: 10, weight: W_FOURTH, role: 'fourth' },
        { step: 14, weight: W_FIFTH, role: 'fifth' },
        { step: 16, weight: 3.6, role: 'degree' },
        { step: 20, weight: W_DEGREE, role: 'degree' },
      ],
    },
    {
      id: 'mahur',
      name: 'Mahur',
      steps: [
        { step: 0, weight: 6.35, role: 'tonic' },
        { step: 4, weight: 3.48, role: 'degree' },
        { step: 8, weight: 4.38, role: 'degree' },
        { step: 10, weight: 4.09, role: 'fourth' },
        { step: 14, weight: 5.19, role: 'fifth' },
        { step: 18, weight: 3.66, role: 'degree' },
        { step: 22, weight: 2.88, role: 'degree' },
      ],
    },
    {
      id: 'esfahan',
      name: 'Bayat-e Esfahan',
      steps: [
        { step: 0, weight: W_TONIC, role: 'tonic' },
        { step: 4, weight: 3.5, role: 'degree' },
        { step: 7, weight: 5.0, role: 'color' },
        { step: 10, weight: W_FOURTH, role: 'fourth' },
        { step: 14, weight: W_FIFTH, role: 'fifth' },
        { step: 16, weight: 4.0, role: 'degree' },
        { step: 22, weight: 3.8, role: 'degree' },
      ],
    },
  ];

  function mod(value, period) {
    return ((value % period) + period) % period;
  }

  function rotateProfile(profile, steps) {
    const n = profile.length;
    const shift = mod(steps, n);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = profile[mod(i - shift, n)];
    return out;
  }

  function buildTemplate(steps) {
    const bins = new Array(24).fill(W_OFF);
    for (let i = 0; i < steps.length; i++) bins[steps[i].step] = steps[i].weight;
    return bins;
  }

  const WESTERN_KEYS = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    WESTERN_KEYS.push({
      id: 'w-' + tonic + '-maj',
      name: NOTE_NAMES[tonic] + ' Major',
      system: 'western',
      profile: rotateProfile(KS_MAJOR, tonic),
    });
    WESTERN_KEYS.push({
      id: 'w-' + tonic + '-min',
      name: NOTE_NAMES[tonic] + ' Minor',
      system: 'western',
      profile: rotateProfile(KS_MINOR, tonic),
    });
  }

  /*
   * A sori or koron tonic is uncommon. Segah is the usual exception, and on
   * the synthetic phrase it leads the best semitone tonic by about 0.10.
   * Subtracting 0.07 lets that true Segah keep its koron tonic, and gives a
   * semitone tonic the win whenever the two are close.
   */
  const QUARTER_TONIC_PENALTY = 0.07;

  const PERSIAN_KEYS = [];
  const PERSIAN_KEYS_AUTO = [];
  PERSIAN_MODES.forEach(function (mode) {
    const template = buildTemplate(mode.steps);
    for (let tonic = 0; tonic < 24; tonic++) {
      const key = {
        id: 'p-' + mode.id + '-' + tonic,
        name: PC24_NAMES[tonic] + ' ' + mode.name,
        system: 'persian',
        profile: rotateProfile(template, tonic),
        tonicPenalty: tonic % 2 ? QUARTER_TONIC_PENALTY : 0,
      };
      PERSIAN_KEYS.push(key);
      if (mode.id !== 'mahur') PERSIAN_KEYS_AUTO.push(key);
    }
  });

  function pearson(a, b) {
    const n = a.length;
    let meanA = 0;
    let meanB = 0;
    for (let i = 0; i < n; i++) {
      meanA += a[i];
      meanB += b[i];
    }
    meanA /= n;
    meanB /= n;
    let num = 0;
    let denA = 0;
    let denB = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - meanA;
      const db = b[i] - meanB;
      num += da * db;
      denA += da * da;
      denB += db * db;
    }
    if (denA <= 1e-12 || denB <= 1e-12) return 0;
    return num / Math.sqrt(denA * denB);
  }

  /**
   * Odd (quarter-tone) bins sit halfway between semitones, so each gives half
   * its energy to the semitone on either side. Even bins pass through.
   * Total energy is unchanged.
   */
  function foldToTwelve(chroma24) {
    const out = new Array(12).fill(0);
    for (let i = 0; i < 12; i++) {
      const below = chroma24[mod(2 * i - 1, 24)];
      const even = chroma24[2 * i];
      const above = chroma24[mod(2 * i + 1, 24)];
      out[i] = even + 0.5 * below + 0.5 * above;
    }
    return out;
  }

  function quarterToneEnergy(chroma24, persistence) {
    let even = 0;
    let odd = 0;
    let maxEven = 0;
    let maxOdd = 0;
    for (let i = 0; i < 24; i++) {
      const v = chroma24[i];
      if (v <= 0) continue;
      if (i % 2 === 0) {
        even += v;
        if (v > maxEven) maxEven = v;
      } else if (!persistence || persistence[i] >= PERSIST_MIN) {
        odd += v;
        if (v > maxOdd) maxOdd = v;
      }
    }
    const total = even + odd;
    return {
      ratio: total > 0 ? odd / total : 0,
      peakRatio: maxEven > 0 ? maxOdd / maxEven : maxOdd > 0 ? Infinity : 0,
      even: even,
      odd: odd,
    };
  }

  function hasSignificantQuarterTones(chroma24, persistence) {
    const energy = quarterToneEnergy(chroma24, persistence);
    return energy.ratio >= QUARTER_RATIO_MIN && energy.peakRatio >= QUARTER_PEAK_MIN;
  }

  function scoreAll(vector, keys) {
    let best = null;
    let second = null;
    const byId = new Map();
    const scores = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const score = pearson(vector, key.profile) - (key.tonicPenalty || 0);
      scores[i] = score;
      const row = {
        id: key.id,
        name: key.name,
        system: key.system,
        profile: key.profile,
        score: score,
      };
      byId.set(key.id, row);
      if (!best || score > best.score) {
        second = best;
        best = row;
      } else if (!second || score > second.score) {
        second = row;
      }
    }
    return { best: best, second: second, byId: byId, scores: scores };
  }

  function bestZ(scored) {
    const scores = scored.scores;
    let mean = 0;
    for (let i = 0; i < scores.length; i++) mean += scores[i];
    mean /= scores.length;
    let variance = 0;
    for (let i = 0; i < scores.length; i++) {
      const d = scores[i] - mean;
      variance += d * d;
    }
    const sd = Math.sqrt(variance / scores.length);
    if (sd < 1e-9) return 0;
    return (scored.best.score - mean) / sd;
  }

  function confidenceLabel(best, second) {
    const margin = best - (second == null ? 0 : second);
    if (margin >= CONF_HIGH) return 'High';
    if (margin >= CONF_MED) return 'Medium';
    return 'Low';
  }

  /**
   * @param {ArrayLike<number>} chroma24
   * @param {'auto'|'western'|'persian'} mode
   * @param {Float64Array|null} persistence per-bin fraction of recent frames
   */
  function detectChroma(chroma24, mode, persistence) {
    const energy = quarterToneEnergy(chroma24, persistence);
    const quarter = hasSignificantQuarterTones(chroma24, persistence);
    let scored;
    let system;
    let zWestern = 0;
    let zPersian = 0;

    if (mode === 'western') {
      system = 'western';
      scored = scoreAll(foldToTwelve(chroma24), WESTERN_KEYS);
    } else if (mode === 'persian') {
      system = 'persian';
      scored = scoreAll(chroma24, PERSIAN_KEYS);
    } else {
      const western = scoreAll(foldToTwelve(chroma24), WESTERN_KEYS);
      const persian = scoreAll(chroma24, PERSIAN_KEYS_AUTO);
      zWestern = bestZ(western);
      zPersian = bestZ(persian);
      /*
       * Pearson values from a 12-bin profile and a 24-bin profile are not
       * comparable. Auto compares each winner's z-score inside its own
       * candidate list, and only then if the quarter-tone test passed.
       */
      const preferPersian = quarter && zPersian > zWestern;
      scored = preferPersian ? persian : western;
      system = scored.best.system;
    }

    const margin = scored.best.score - (scored.second ? scored.second.score : scored.best.score);
    return {
      best: scored.best,
      second: scored.second,
      byId: scored.byId,
      system: system,
      ratio: energy.ratio,
      peakRatio: energy.peakRatio,
      quarterSignificant: quarter,
      confidence: confidenceLabel(scored.best.score, scored.second && scored.second.score),
      margin: margin,
      zWestern: zWestern,
      zPersian: zPersian,
    };
  }

  function centsFromC(freq) {
    return 1200 * Math.log2(freq / C4);
  }

  /** Deviation from the nearest 12-TET semitone, in (−50, 50]. */
  function deviationCents(freq) {
    const wrapped = mod(centsFromC(freq), 100);
    return wrapped > 50 ? wrapped - 100 : wrapped;
  }

  function tuningCentsFromMoments(sumSin, sumCos) {
    if (Math.abs(sumSin) + Math.abs(sumCos) < 1e-12) return 0;
    const offset = (Math.atan2(sumSin, sumCos) / (2 * Math.PI)) * 100;
    return mod(offset + 50, 100) - 50;
  }

  /*
   * Tuning offset of the 12-TET grid relative to A=440.
   * Votes are local maxima of the 10-cent histogram. Counting every occupied
   * bin equally lets vibrato, the tombak, and harmonics near ±50 cents
   * outvote the scale, and the badge then sticks at "tuning −50¢": the
   * chromagram slides by a quarter tone and a Shur performance is renamed
   * as a koron-tonic mode (B-sori Chahargah on the clip this was tuned against).
   * The search keeps the cluster 50 cents away when that cluster contains
   * more substantial peaks, so one loud koron (Segah's tonic and drone)
   * cannot drag the other degrees off the semitone grid either.
   */
  function estimateTuningCents(fine) {
    let max = 0;
    for (let i = 0; i < FINE_BINS; i++) if (fine[i] > max) max = fine[i];
    if (max <= 0) return 0;
    const thresh = max * 0.04;
    const peaks = [];
    for (let j = 0; j < FINE_BINS; j++) {
      const v = fine[j];
      if (v < thresh) continue;
      const prev = fine[mod(j - 1, FINE_BINS)];
      const next = fine[mod(j + 1, FINE_BINS)];
      if (v < prev || v <= next) continue;
      const denom = prev - 2 * v + next;
      let delta = denom === 0 ? 0 : (0.5 * (prev - next)) / denom;
      if (delta > 0.5) delta = 0.5;
      else if (delta < -0.5) delta = -0.5;
      peaks.push({ cents: mod((j + delta) * 10, 1200), w: v });
    }
    if (!peaks.length) return 0;

    let loud = 0;
    for (let i = 0; i < peaks.length; i++) if (peaks[i].w > loud) loud = peaks[i].w;
    const voteFloor = loud * 0.15;
    const voting = [];
    for (let i = 0; i < peaks.length; i++) {
      if (peaks[i].w >= voteFloor) voting.push(peaks[i]);
    }
    if (!voting.length) return 0;

    function support(theta) {
      let n = 0;
      let energy = 0;
      const matched = [];
      for (let i = 0; i < voting.length; i++) {
        const dev = mod(voting[i].cents - theta + 50, 100) - 50;
        if (Math.abs(dev) > 18) continue;
        n++;
        energy += voting[i].w;
        matched.push(voting[i]);
      }
      let loudest = 0;
      for (let i = 0; i < matched.length; i++) {
        if (matched[i].w > loudest) loudest = matched[i].w;
      }
      // Drop the single loudest peak so a drone cannot win a tie.
      const tieEnergy = energy - loudest;
      return { n: n, energy: energy, tieEnergy: tieEnergy, matched: matched, theta: theta };
    }

    let best = null;
    for (let t = -50; t < 50; t++) {
      const row = support(t);
      // Rank by energy with the loudest peak removed, so a drone or one
      // koron cannot outweigh the rest of the scale, and a spray of faint
      // peaks cannot outweigh it either.
      if (!best || row.tieEnergy > best.tieEnergy || (row.tieEnergy === best.tieEnergy && row.n > best.n)) best = row;
    }
    if (!best || !best.matched.length) return 0;

    let sumSin = 0;
    let sumCos = 0;
    let weight = 0;
    for (let i = 0; i < best.matched.length; i++) {
      const dev = mod(best.matched[i].cents + 50, 100) - 50;
      const ang = (dev / 100) * 2 * Math.PI;
      sumSin += best.matched[i].w * Math.sin(ang);
      sumCos += best.matched[i].w * Math.cos(ang);
      weight += best.matched[i].w;
    }
    if (weight <= 0 || Math.hypot(sumSin, sumCos) / weight < 0.45) return 0;
    return tuningCentsFromMoments(sumSin, sumCos);
  }

  function addCents(hist, cents, weight) {
    const x = mod(cents, 1200) / 10;
    const i0 = Math.floor(x);
    const frac = x - i0;
    hist[mod(i0, FINE_BINS)] += (1 - frac) * weight;
    hist[mod(i0 + 1, FINE_BINS)] += frac * weight;
  }

  function fineToChroma24(fine, offsetCents) {
    const chroma = new Float64Array(24);
    for (let j = 0; j < FINE_BINS; j++) {
      const weight = fine[j];
      if (weight === 0) continue;
      const aligned = j * 10 - offsetCents;
      const x = mod(aligned, 1200) / 50;
      const i0 = Math.floor(x);
      const frac = x - i0;
      chroma[mod(i0, 24)] += (1 - frac) * weight;
      chroma[mod(i0 + 1, 24)] += frac * weight;
    }
    return chroma;
  }

  function medianOf(values) {
    if (!values.length) return -240;
    values.sort(function (a, b) { return a - b; });
    const mid = values.length >> 1;
    if (values.length % 2) return values[mid];
    return 0.5 * (values[mid - 1] + values[mid]);
  }

  function parabolicHz(db, k, hzPerBin) {
    const a = db[k - 1];
    const b = db[k];
    const c = db[k + 1];
    const denom = a - 2 * b + c;
    let delta = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
    if (delta > 0.5) delta = 0.5;
    else if (delta < -0.5) delta = -0.5;
    return (k + delta) * hzPerBin;
  }

  /**
   * Peaks that rise PROMINENCE_DB above the local third-octave median and sit
   * within PEAK_RANGE_DB of the frame's strongest bin. Magnitude is sqrt of
   * linear amplitude so one loud partial cannot own the frame.
   */
  function pickPeaks(db, sampleRate, fftSize) {
    const n = db.length;
    const hzPerBin = sampleRate / fftSize;
    const k0 = Math.max(2, Math.ceil(F_MIN / hzPerBin));
    const k1 = Math.min(n - 3, Math.floor(F_MAX / hzPerBin));
    let maxDb = -Infinity;
    for (let k = k0; k <= k1; k++) {
      if (db[k] > maxDb) maxDb = db[k];
    }
    if (!Number.isFinite(maxDb)) return [];
    const floor = maxDb - PEAK_RANGE_DB;
    const third = Math.pow(2, 1 / 3);
    const peaks = [];
    const window = [];
    for (let k = k0; k <= k1; k++) {
      const b = db[k];
      if (!Number.isFinite(b) || b < floor) continue;
      if (b < db[k - 1] || b < db[k + 1]) continue;
      const lo = Math.max(1, Math.round(k / third));
      const hi = Math.min(n - 2, Math.round(k * third));
      window.length = 0;
      for (let j = lo; j <= hi; j++) {
        if (j >= k - 3 && j <= k + 3) continue;
        if (Number.isFinite(db[j])) window.push(db[j]);
      }
      if (window.length < 5) continue;
      const med = medianOf(window);
      if (b < med + PROMINENCE_DB) continue;
      const freq = parabolicHz(db, k, hzPerBin);
      if (freq < F_MIN || freq > F_MAX) continue;
      const linear = Math.pow(10, b / 20);
      peaks.push({ freq: freq, db: b, amp: Math.sqrt(linear), bin: k });
    }
    return peaks;
  }

  /**
   * Drop a peak at f when a stronger peak sits within ±20 cents of f/h, h = 2..16.
   * h through 8 removes the 7th (~31 cents off 12-TET). The 11th (~49 cents off)
   * and 13th (~40 cents off) need h through 16; left in, a tar or voice paints
   * a fake quarter-tone on every scale degree.
   */
  function suppressHarmonics(peaks) {
    if (peaks.length < 2) return peaks.slice();
    const sorted = peaks.slice().sort(function (a, b) { return a.freq - b.freq; });
    const kept = [];
    for (let i = 0; i < sorted.length; i++) {
      const peak = sorted[i];
      let harmonic = false;
      for (let h = 2; h <= 16 && !harmonic; h++) {
        const fundamental = peak.freq / h;
        const low = fundamental * Math.pow(2, -HARMONIC_CENTS / 1200);
        const high = fundamental * Math.pow(2, HARMONIC_CENTS / 1200);
        for (let j = 0; j < sorted.length; j++) {
          const other = sorted[j];
          if (other === peak) continue;
          if (other.freq < low) continue;
          if (other.freq > high) break;
          if (other.amp > peak.amp) {
            harmonic = true;
            break;
          }
        }
      }
      if (!harmonic) kept.push(peak);
    }
    return kept;
  }

  function spectralFlatness(db, sampleRate, fftSize) {
    const hzPerBin = sampleRate / fftSize;
    const k0 = Math.max(1, Math.ceil(F_MIN / hzPerBin));
    const k1 = Math.min(db.length - 1, Math.floor(F_MAX / hzPerBin));
    let logSum = 0;
    let linSum = 0;
    let count = 0;
    for (let k = k0; k <= k1; k += 2) {
      const mag = Math.pow(10, Math.max(-120, db[k]) / 20);
      logSum += Math.log(mag + 1e-12);
      linSum += mag;
      count++;
    }
    if (!count || linSum <= 0) return 1;
    return Math.exp(logSum / count) / (linSum / count);
  }

  function createAnalysisState() {
    return {
      fine: new Float64Array(FINE_BINS),
      tuningCents: 0,
      recent: [],
      tonalSeconds: 0,
    };
  }

  function resetAnalysisState(state) {
    state.fine.fill(0);
    state.tuningCents = 0;
    state.recent.length = 0;
    state.tonalSeconds = 0;
  }

  function persistenceByBin(recent) {
    const n = recent.length;
    if (!n) return null;
    const out = new Float64Array(24);
    for (let b = 1; b < 24; b += 2) {
      let hits = 0;
      let seen = 0;
      for (let i = 0; i < n; i++) {
        const frame = recent[i];
        let sum = 0;
        for (let k = 0; k < 24; k++) sum += frame[k];
        if (sum <= 0) continue;
        seen++;
        if (frame[b] / sum >= PERSIST_SHARE) hits++;
      }
      out[b] = seen ? hits / seen : 0;
    }
    return out;
  }

  /**
   * One analysis hop. Decays the fine histogram (half-life HALF_LIFE_SEC),
   * folds accepted peaks into it, and updates the tuning moments.
   * Returns whether the frame was tonal enough to keep.
   */
  function pushSpectrumFrame(state, db, sampleRate, fftSize, dtSec) {
    const dt = dtSec > 0 ? dtSec : HOP_SEC;
    const decay = Math.pow(0.5, dt / HALF_LIFE_SEC);
    const fine = state.fine;
    for (let i = 0; i < FINE_BINS; i++) fine[i] *= decay;

    const rawPeaks = pickPeaks(db, sampleRate, fftSize);
    const peaks = suppressHarmonics(rawPeaks);
    const flatness = spectralFlatness(db, sampleRate, fftSize);
    const tonalWeight = peaks.length ? Math.max(0.25, 1 - flatness) : 0;
    if (!peaks.length || tonalWeight <= 0) {
      return {
        accepted: false,
        tuningCents: state.tuningCents,
        rawPeaks: rawPeaks,
        peaks: peaks,
        flatness: flatness,
      };
    }

    const frameFine = new Float64Array(FINE_BINS);
    for (let i = 0; i < peaks.length; i++) {
      const peak = peaks[i];
      const weight = peak.amp * tonalWeight;
      const cents = centsFromC(peak.freq);
      addCents(fine, cents, weight);
      addCents(frameFine, cents, weight);
    }
    state.tuningCents = estimateTuningCents(fine);

    const frameChroma = fineToChroma24(frameFine, state.tuningCents);
    state.recent.push(frameChroma);
    if (state.recent.length > RECENT_FRAMES) state.recent.shift();
    state.tonalSeconds += dt;
    return {
      accepted: true,
      tuningCents: state.tuningCents,
      rawPeaks: rawPeaks,
      peaks: peaks,
      flatness: flatness,
      chroma: frameChroma,
    };
  }

  function analyzeState(state, mode) {
    const chroma = fineToChroma24(state.fine, state.tuningCents);
    const persistence = persistenceByBin(state.recent);
    const result = detectChroma(chroma, mode, persistence);
    result.tuningCents = state.tuningCents;
    result.tonalSeconds = state.tonalSeconds;
    result.chroma = chroma;
    return result;
  }

  function formatTuning(cents) {
    const rounded = Math.round(cents);
    if (rounded < 0) return 'tuning −' + Math.abs(rounded) + '¢';
    if (rounded > 0) return 'tuning +' + rounded + '¢';
    return 'tuning 0¢';
  }

  function fftRadix2(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let wRe = 1;
        let wIm = 0;
        for (let k = 0; k < half; k++) {
          const j = i + k + half;
          const vRe = re[j] * wRe - im[j] * wIm;
          const vIm = re[j] * wIm + im[j] * wRe;
          const uRe = re[i + k];
          const uIm = im[i + k];
          re[i + k] = uRe + vRe;
          im[i + k] = uIm + vIm;
          re[j] = uRe - vRe;
          im[j] = uIm - vIm;
          const nextRe = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nextRe;
        }
      }
    }
  }

  /*
   * On/off settings in storage.local. `globalOff` hides KookTube everywhere;
   * `off:<hostname>` hides it on one site. popup.js writes the same keys.
   */
  const GLOBAL_OFF_KEY = 'globalOff';

  function siteOffKey(hostname) {
    return 'off:' + hostname;
  }

  function siteEnabled(items, hostname) {
    if (!items) return true;
    return !items[GLOBAL_OFF_KEY] && !items[siteOffKey(hostname)];
  }

  function boot() {
    if (globalThis.__kooktubeKeyDetectorLoaded) return;
    globalThis.__kooktubeKeyDetectorLoaded = true;

    const MODES = ['auto', 'western', 'persian'];
    const MODE_LABEL = { auto: 'Auto', western: 'Western', persian: 'Persian' };

    const state = {
      mode: 'western',
      audioCtx: null,
      analyser: null,
      output: null,
      freqData: null,
      workletNode: null,
      muteGain: null,
      useWorklet: false,
      fallbackTimer: 0,
      video: null,
      videoId: undefined,
      onWatch: false,
      analysis: createAnalysisState(),
      held: null,
      captureError: false,
      suspendTimer: 0,
      suspendToken: 0,
      userGesture: false,
      audioReady: false,
      arming: false,
      semitones: 0,
      source: null,
      pitchNode: null,
      pitchParam: null,
      pitchFailed: false,
      drmBlocked: false,
      enabled: null,
    };

    const host = document.createElement('div');
    host.id = 'kooktube-key-detector';
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', 'KookTube key detector');
    [
      ['position', 'fixed'],
      ['bottom', '20px'],
      ['right', '20px'],
      ['z-index', '2147483647'],
      ['width', 'max-content'],
      ['max-width', 'calc(100vw - 32px)'],
      ['margin', '0'],
      ['padding', '0'],
      ['border', '0'],
      ['background', 'transparent'],
      ['pointer-events', 'auto'],
      ['display', 'none'],
    ].forEach(function (pair) {
      host.style.setProperty(pair[0], pair[1], 'important');
    });

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent =
      ':host{all:initial}' +
      '.badge{box-sizing:border-box;min-width:210px;padding:10px 12px 9px;border-radius:14px;' +
      'background:#141414;color:#f5f5f5;font-family:Roboto,Arial,sans-serif;font-size:13px;' +
      'line-height:1.35;box-shadow:0 10px 28px rgba(0,0,0,.48),0 0 0 1px rgba(255,255,255,.07)}' +
      '.label{margin:0;font-weight:600;letter-spacing:.01em}' +
      '.label.pending{color:#c8c8c8;font-weight:500}' +
      '.tuning{margin:2px 0 8px;font-size:11px;font-weight:500;color:#9a9a9a}' +
      '.pitch{display:flex;align-items:center;gap:6px;margin:0 0 8px}' +
      '.pitch span{flex:1;text-align:center;font-size:12px;font-weight:600;color:#d7d7d7}' +
      '.pitch button{min-width:32px;padding:4px 0}' +
      '.actions{display:flex;gap:6px}' +
      'button{box-sizing:border-box;margin:0;border:1px solid rgba(255,255,255,.14);background:#242424;' +
      'color:#f2f2f2;border-radius:8px;padding:4px 10px;font:600 12px/1.2 Roboto,Arial,sans-serif;cursor:pointer}' +
      'button:hover{background:#323232}' +
      'button:active{background:#1c1c1c}' +
      'button:focus-visible{outline:2px solid #9ecbff;outline-offset:1px}' +
      '#mode{color:#8ec5ff;min-width:78px}';
    const badge = document.createElement('div');
    badge.className = 'badge';
    const labelEl = document.createElement('p');
    labelEl.className = 'label pending';
    labelEl.textContent = 'Click the page to start listening';
    const tuningEl = document.createElement('p');
    tuningEl.className = 'tuning';
    tuningEl.textContent = '';
    const pitchRow = document.createElement('div');
    pitchRow.className = 'pitch';
    const pitchDown = document.createElement('button');
    pitchDown.type = 'button';
    pitchDown.textContent = '−';
    pitchDown.setAttribute('aria-label', 'Lower the music by one semitone without changing the video speed');
    const pitchLabel = document.createElement('span');
    pitchLabel.textContent = 'Transpose 0';
    const pitchUp = document.createElement('button');
    pitchUp.type = 'button';
    pitchUp.textContent = '+';
    pitchUp.setAttribute('aria-label', 'Raise the music by one semitone without changing the video speed');
    pitchRow.append(pitchDown, pitchLabel, pitchUp);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.id = 'mode';
    modeBtn.textContent = 'Auto';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.id = 'reset';
    resetBtn.textContent = 'Reset';
    actions.append(modeBtn, resetBtn);
    badge.append(labelEl, tuningEl, pitchRow, actions);

    function formatTranspose(steps) {
      if (steps > 0) return 'Transpose +' + steps;
      if (steps < 0) return 'Transpose −' + Math.abs(steps);
      return 'Transpose 0';
    }

    function setSemitones(steps) {
      if (state.pitchFailed) return;
      const next = Math.max(-12, Math.min(12, steps));
      state.semitones = next;
      if (state.pitchParam) state.pitchParam.value = next;
      pitchLabel.textContent = formatTranspose(next);
      pitchDown.disabled = next <= -12;
      pitchUp.disabled = next >= 12;
    }

    pitchDown.addEventListener('click', function () { setSemitones(state.semitones - 1); });
    pitchUp.addEventListener('click', function () { setSemitones(state.semitones + 1); });
    shadow.append(style, badge);

    ['pointerdown', 'mousedown', 'click', 'dblclick', 'pointerup'].forEach(function (type) {
      badge.addEventListener(type, function (event) {
        event.stopPropagation();
      });
    });

    function syncModeButton() {
      modeBtn.textContent = MODE_LABEL[state.mode];
      modeBtn.setAttribute(
        'aria-label',
        'Detection mode ' + MODE_LABEL[state.mode] + '. Activate to cycle Auto, Western, and Persian.'
      );
    }

    modeBtn.addEventListener('click', function () {
      const index = MODES.indexOf(state.mode);
      state.mode = MODES[(index + 1) % MODES.length];
      state.held = null;
      syncModeButton();
      render();
    });

    resetBtn.setAttribute('aria-label', 'Clear the accumulated audio buffer');
    resetBtn.addEventListener('click', function () {
      resetAnalysisState(state.analysis);
      state.held = null;
      render();
    });

    document.documentElement.appendChild(host);
    syncModeButton();

    function siteKind() {
      const host = location.hostname;
      if (host === 'open.spotify.com') return 'spotify';
      if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return 'soundcloud';
      if (host === 'www.youtube.com' || host === 'music.youtube.com' || host === 'm.youtube.com') return 'youtube';
      if (isPlayerHost(host)) return 'media';
      return '';
    }

    function isPlayerHost(host) {
      const names = [
        'suno.com', 'udio.com', 'radiojavan.com', 'bandcamp.com',
        'instagram.com', 'tiktok.com', 'facebook.com', 'vimeo.com',
        'mixcloud.com', 'audiomack.com', 'twitch.tv', 'aparat.com', 'archive.org',
      ];
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (host === name || host === 'www.' + name || host.endsWith('.' + name)) return true;
      }
      return false;
    }

    function videoIdFromLocation() {
      try {
        if (location.pathname.indexOf('/shorts/') === 0) {
          const parts = location.pathname.split('/');
          return parts[2] || null;
        }
        return new URL(location.href).searchParams.get('v');
      } catch (err) {
        return null;
      }
    }

    function trackId() {
      const kind = siteKind();
      if (kind === 'youtube') return videoIdFromLocation();
      if (kind === 'spotify') {
        const link = document.querySelector(
          '[data-testid="now-playing-widget"] a[href*="/track/"], [data-testid="now-playing-widget"] a[href*="/episode/"], a[data-testid="context-item-link"]'
        );
        if (link) return link.getAttribute('href') || link.href;
      }
      if (kind === 'soundcloud') {
        const link = document.querySelector('.playbackSoundBadge__title a[href], .playControls__soundBadge a[href]');
        if (link) return link.getAttribute('href') || link.href;
      }
      if (kind === 'media') {
        const nodes = document.querySelectorAll('audio, video');
        for (let i = 0; i < nodes.length; i++) {
          if (!nodes[i].paused && !nodes[i].ended) return location.pathname + '|' + (nodes[i].currentSrc || '');
        }
      }
      return location.pathname;
    }

    function isMusicPage() {
      const kind = siteKind();
      if (kind === 'spotify' || kind === 'soundcloud' || kind === 'media') return true;
      if (kind === 'youtube') {
        return location.pathname === '/watch' || location.pathname.indexOf('/shorts/') === 0;
      }
      return false;
    }

    function findPlaying(nodes) {
      let attached = null;
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (el.__kooktubeGraphAttached) attached = el;
        if (!el.paused && !el.ended) return el;
      }
      if (attached) return attached;
      return nodes.length ? nodes[nodes.length - 1] : null;
    }

    function findVideo() {
      if (siteKind() === 'youtube') {
        if (location.pathname.indexOf('/shorts/') === 0) {
          const root = document.getElementById('shorts-player');
          const shortsVideo = root && root.querySelector('video');
          if (shortsVideo) return shortsVideo;
        }
        return document.querySelector('video.html5-main-video')
          || document.querySelector('#movie_player video');
      }
      return findPlaying(document.querySelectorAll('audio, video'));
    }

    function encryptedMedia(media) {
      try {
        return !!(media && media.mediaKeys);
      } catch (err) {
        return false;
      }
    }

    function adPlaying() {
      const player = document.getElementById('movie_player');
      if (!player) return false;
      return player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
    }

    function setWatchVisible(onWatch) {
      state.onWatch = onWatch;
      host.style.setProperty('display', onWatch && state.enabled === true ? 'block' : 'none', 'important');
    }

    function gestureOk() {
      if (state.userGesture) return true;
      try {
        return !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
      } catch (err) {
        return false;
      }
    }

    function scheduleSuspend() {
      const token = ++state.suspendToken;
      if (state.suspendTimer) clearTimeout(state.suspendTimer);
      state.suspendTimer = window.setTimeout(function () {
        state.suspendTimer = 0;
        if (token !== state.suspendToken) return;
        const video = findVideo();
        if (video && !video.paused && !video.ended) return;
        if (state.audioCtx && state.audioCtx.state === 'running') state.audioCtx.suspend();
      }, 500);
    }

    function cancelSuspend() {
      state.suspendToken++;
      if (state.suspendTimer) {
        clearTimeout(state.suspendTimer);
        state.suspendTimer = 0;
      }
    }

    function onAudioMessage(event) {
      if (!state.enabled) return;
      try {
        const data = event.data;
        if (!data || !data.db) return;
        if (adPlaying()) return;
        const video = state.video;
        if (!video || video.paused || video.ended) return;
        pushSpectrumFrame(
          state.analysis,
          data.db,
          data.sampleRate || state.audioCtx.sampleRate,
          data.fftSize || FFT_SIZE,
          data.dt || HOP_SEC
        );
      } catch (err) {
        /* A bad frame must not break the YouTube page. */
      }
    }

    function ensureGraph() {
      if (state.audioCtx) return;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new AudioCtx();
      state.output = state.audioCtx.createBiquadFilter();
      state.output.type = 'highpass';
      state.output.frequency.value = 20;
      state.output.Q.value = 0.707;
      state.output.connect(state.audioCtx.destination);
    }

    function setupFallbackAnalyser() {
      if (state.analyser || !state.audioCtx) return;
      state.analyser = state.audioCtx.createAnalyser();
      state.analyser.fftSize = FFT_SIZE;
      state.analyser.smoothingTimeConstant = 0;
      state.freqData = new Float32Array(state.analyser.frequencyBinCount);
      state.useWorklet = false;
    }

    function armAudio() {
      if (!state.enabled || state.arming || !gestureOk()) return;
      const video = findVideo();
      if (!video) return;
      state.arming = true;
      ensureGraph();
      const ctx = state.audioCtx;
      const finish = function () {
        state.arming = false;
      };
      if (ctx.state !== 'running') {
        let resumed;
        try {
          resumed = ctx.resume();
        } catch (err) {
          finish();
          return;
        }
        Promise.resolve(resumed).then(function () {
          if (ctx.state !== 'running') {
            finish();
            return;
          }
          state.audioReady = true;
          attachPipeline(video).then(finish, finish);
        }, finish);
        return;
      }
      state.audioReady = true;
      attachPipeline(video).then(finish, finish);
    }

    function extApi() {
      if (typeof browser !== 'undefined' && browser.runtime) return browser;
      if (typeof chrome !== 'undefined' && chrome.runtime) return chrome;
      return null;
    }

    function extensionURL(file) {
      const ext = extApi();
      const runtime = ext && ext.runtime;
      try {
        return runtime && runtime.getURL ? runtime.getURL(file) : '';
      } catch (err) {
        return '';
      }
    }

    function routeSource() {
      if (!state.source) return;
      const hear = state.pitchNode || state.output;
      try { state.source.disconnect(state.output); } catch (err) { /* not connected there */ }
      try { state.source.disconnect(state.pitchNode); } catch (err) { /* not connected there */ }
      state.source.connect(hear);
    }

    function loadPitchShift() {
      if (state.pitchNode || state.pitchFailed || !state.audioCtx || !state.audioCtx.audioWorklet) {
        return Promise.resolve();
      }
      const url = extensionURL('pitch.js');
      if (!url) {
        state.pitchFailed = true;
        return Promise.resolve();
      }
      return state.audioCtx.audioWorklet.addModule(url).then(function () {
        let node;
        try {
          node = new AudioWorkletNode(state.audioCtx, 'kooktube-pitch', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 2,
            channelCountMode: 'explicit',
            outputChannelCount: [2],
          });
        } catch (err) {
          node = new AudioWorkletNode(state.audioCtx, 'kooktube-pitch', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 2,
          });
        }
        state.pitchNode = node;
        state.pitchParam = node.parameters.get('semitones');
        state.pitchParam.value = state.semitones;
        node.connect(state.output);
        routeSource();
      }).catch(function () {
        state.pitchFailed = true;
        pitchLabel.textContent = 'Transpose unavailable';
        pitchDown.disabled = true;
        pitchUp.disabled = true;
      });
    }

    function attachPipeline(video) {
      if (state.useWorklet || state.analyser) return Promise.resolve();
      const url = extensionURL('worklet.js');
      if (!url || !state.audioCtx.audioWorklet) {
        setupFallbackAnalyser();
        return Promise.resolve();
      }
      return state.audioCtx.audioWorklet.addModule(url).then(function () {
        state.workletNode = new AudioWorkletNode(state.audioCtx, 'kooktube-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 2,
        });
        state.workletNode.port.onmessage = onAudioMessage;
        state.muteGain = state.audioCtx.createGain();
        state.muteGain.gain.value = 0;
        state.workletNode.connect(state.muteGain);
        state.muteGain.connect(state.audioCtx.destination);
        state.useWorklet = true;
        return loadPitchShift();
      }).catch(function () {
        setupFallbackAnalyser();
        return loadPitchShift();
      });
    }

    function attachVideo(video) {
      if (!video || !state.enabled) return;
      if (video.__kooktubeGraphFailed) {
        state.captureError = true;
        return;
      }
      if (video.__kooktubeGraphAttached) return;
      if (encryptedMedia(video)) {
        state.drmBlocked = true;
        return;
      }
      if (!state.audioReady || !state.audioCtx || state.audioCtx.state !== 'running') return;
      if (!state.useWorklet && !state.analyser) return;
      try {
        if (state.mediaEl && state.mediaEl !== video && state.source) {
          try { state.source.disconnect(); } catch (err) { /* old player is already gone */ }
          state.source = null;
        }
        const source = state.audioCtx.createMediaElementSource(video);
        state.mediaEl = video;
        video.__kooktubeGraphAttached = true;
        state.source = source;
        source.connect(state.pitchNode || state.output);
        if (state.useWorklet && state.workletNode) source.connect(state.workletNode);
        else if (state.analyser) source.connect(state.analyser);
        video.addEventListener('play', function () {
          cancelSuspend();
          if (state.audioCtx && state.audioCtx.state === 'suspended') state.audioCtx.resume();
        });
        video.addEventListener('pause', scheduleSuspend);
        video.addEventListener('ended', scheduleSuspend);
      } catch (err) {
        video.__kooktubeGraphFailed = true;
        state.captureError = true;
      }
    }

    function syncPage() {
      const onWatch = isMusicPage();
      const id = trackId();
      if (id !== state.videoId) {
        state.videoId = id;
        state.captureError = false;
        resetAnalysisState(state.analysis);
        state.held = null;
      }
      setWatchVisible(onWatch);
      if (!onWatch) {
        state.video = null;
        state.drmBlocked = false;
        return;
      }
      const video = findVideo();
      if (!video) return;
      state.video = video;
      state.drmBlocked = encryptedMedia(video);
      if (state.drmBlocked) return;
      if (!state.enabled) return;
      if (gestureOk()) armAudio();
      if (state.audioReady) attachVideo(video);
    }

    function syncAudioEngine() {
      if (!state.audioCtx || !state.audioReady) return;
      const video = state.video;
      const playing = !!(video && !video.paused && !video.ended);
      if (playing) {
        cancelSuspend();
        if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
        return;
      }
      if (state.audioCtx.state === 'running' && !state.suspendTimer) scheduleSuspend();
    }

    function fallbackFrame() {
      if (!state.enabled) return;
      if (state.useWorklet || !state.analyser || !state.freqData) return;
      if (adPlaying()) return;
      const video = state.video;
      if (!video || video.paused || video.ended) return;
      if (!state.audioCtx || state.audioCtx.state !== 'running') return;
      state.analyser.getFloatFrequencyData(state.freqData);
      pushSpectrumFrame(state.analysis, state.freqData, state.audioCtx.sampleRate, state.analyser.fftSize, HOP_SEC);
    }

    function applyHold(result) {
      const next = result.best;
      if (!next) return null;
      if (!state.held || state.held.system !== next.system) {
        state.held = next;
        return { row: next, confidence: result.confidence };
      }
      const heldNow = result.byId.get(state.held.id);
      if (heldNow && heldNow.score >= next.score - HOLD_MARGIN) {
        state.held = heldNow;
        const margin = heldNow.score - (result.second && result.second.id !== heldNow.id ? result.second.score : heldNow.score);
        return { row: heldNow, confidence: confidenceLabel(heldNow.score, heldNow.score - margin) };
      }
      state.held = next;
      return { row: next, confidence: result.confidence };
    }

    function render() {
      if (!state.onWatch || !state.enabled) return;
      tuningEl.textContent = state.analysis.tonalSeconds > 0 ? formatTuning(state.analysis.tuningCents) : '';
      if (state.drmBlocked) {
        labelEl.classList.add('pending');
        labelEl.textContent = 'This player encrypts its audio';
        return;
      }
      if (adPlaying()) {
        labelEl.classList.add('pending');
        labelEl.textContent = 'Paused for ad';
        return;
      }
      if (state.captureError) {
        labelEl.classList.add('pending');
        labelEl.textContent = 'Audio capture unavailable';
        return;
      }
      if (!state.audioReady || !state.video || state.video.__kooktubeGraphAttached !== true) {
        labelEl.classList.add('pending');
        labelEl.textContent = 'Click the page to start listening';
        return;
      }
      if (state.analysis.tonalSeconds < WARMUP_SEC) {
        const pct = Math.round((state.analysis.tonalSeconds / WARMUP_SEC) * 100);
        labelEl.classList.add('pending');
        labelEl.textContent = 'Listening… ' + pct + '%';
        return;
      }
      const result = analyzeState(state.analysis, state.mode);
      const chosen = applyHold(result);
      if (!chosen) return;
      labelEl.classList.remove('pending');
      labelEl.textContent = 'Key: ' + chosen.row.name + ' · ' + chosen.confidence;
    }

    function placeHost() {
      let fullscreen = document.fullscreenElement || document.webkitFullscreenElement || null;
      if (fullscreen && fullscreen.nodeName === 'VIDEO') fullscreen = fullscreen.parentElement;
      const parent = fullscreen && fullscreen.nodeType === 1 ? fullscreen : document.documentElement;
      if (host.parentNode !== parent) parent.appendChild(host);
      host.style.setProperty('bottom', fullscreen ? '84px' : '20px', 'important');
    }

    function onGesture() {
      state.userGesture = true;
      armAudio();
    }

    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('keydown', onGesture, true);

    function onNavigate() {
      syncPage();
      placeHost();
      render();
      reportEnabled();
    }

    /*
     * The toolbar popup turns KookTube off everywhere or for this site. While
     * off, nothing new is attached. A player that was already attached stays
     * routed through the audio graph until the tab is refreshed, so transpose
     * goes back to 0 and analysis stops, which leaves that audio untouched.
     */
    const SITE_KEY = siteOffKey(location.hostname);
    const settings = {};

    function setEnabled(on) {
      if (state.enabled === on) return;
      state.enabled = on;
      if (!on) {
        setSemitones(0);
        state.held = null;
      }
      onNavigate();
    }

    function reportEnabled() {
      if (state.enabled === null) return;
      const ext = extApi();
      if (!ext || !ext.runtime.sendMessage) return;
      try {
        const sent = ext.runtime.sendMessage({ type: 'kooktube-state', enabled: state.enabled });
        if (sent && sent.catch) sent.catch(function () { /* background is not listening */ });
      } catch (err) {
        /* The extension was reloaded and this tab has not been refreshed. */
      }
    }

    function loadEnabled() {
      const ext = extApi();
      const area = ext && ext.storage && ext.storage.local;
      if (!area) {
        setEnabled(true);
        return;
      }
      try {
        Promise.resolve(area.get([GLOBAL_OFF_KEY, SITE_KEY])).then(function (items) {
          if (items) {
            settings[GLOBAL_OFF_KEY] = items[GLOBAL_OFF_KEY];
            settings[SITE_KEY] = items[SITE_KEY];
          }
          setEnabled(siteEnabled(settings, location.hostname));
        }, function () {
          setEnabled(true);
        });
      } catch (err) {
        setEnabled(true);
      }
      ext.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'local') return;
        if (!changes[GLOBAL_OFF_KEY] && !changes[SITE_KEY]) return;
        if (changes[GLOBAL_OFF_KEY]) settings[GLOBAL_OFF_KEY] = changes[GLOBAL_OFF_KEY].newValue;
        if (changes[SITE_KEY]) settings[SITE_KEY] = changes[SITE_KEY].newValue;
        setEnabled(siteEnabled(settings, location.hostname));
      });
      ext.runtime.onMessage.addListener(function (message, sender, sendResponse) {
        if (!message || message.type !== 'kooktube-host') return;
        sendResponse({ host: location.hostname });
      });
    }

    window.addEventListener('yt-navigate-finish', onNavigate, true);
    document.addEventListener('yt-navigate-finish', onNavigate, true);
    window.addEventListener('popstate', onNavigate, true);
    document.addEventListener('fullscreenchange', placeHost, true);
    document.addEventListener('webkitfullscreenchange', placeHost, true);

    window.setInterval(function () {
      try {
        syncPage();
        placeHost();
        syncAudioEngine();
        fallbackFrame();
        render();
      } catch (err) {
        /* A bad frame must not break the YouTube page. */
      }
    }, HOP_SEC * 1000);

    onNavigate();
    loadEnabled();
  }

  return {
    boot: boot,
    GLOBAL_OFF_KEY: GLOBAL_OFF_KEY,
    siteOffKey: siteOffKey,
    siteEnabled: siteEnabled,
    detectChroma: detectChroma,
    hasSignificantQuarterTones: hasSignificantQuarterTones,
    quarterToneEnergy: quarterToneEnergy,
    pearson: pearson,
    foldToTwelve: foldToTwelve,
    pickPeaks: pickPeaks,
    suppressHarmonics: suppressHarmonics,
    centsFromC: centsFromC,
    deviationCents: deviationCents,
    tuningCentsFromMoments: tuningCentsFromMoments,
    estimateTuningCents: estimateTuningCents,
    addCents: addCents,
    fineToChroma24: fineToChroma24,
    createAnalysisState: createAnalysisState,
    resetAnalysisState: resetAnalysisState,
    pushSpectrumFrame: pushSpectrumFrame,
    analyzeState: analyzeState,
    persistenceByBin: persistenceByBin,
    spectralFlatness: spectralFlatness,
    formatTuning: formatTuning,
    fftRadix2: fftRadix2,
    PC24_NAMES: PC24_NAMES,
    NOTE_NAMES: NOTE_NAMES,
    PERSIAN_MODES: PERSIAN_MODES,
    KS_MAJOR: KS_MAJOR,
    KS_MINOR: KS_MINOR,
    C4: C4,
    A4: A4,
    FFT_SIZE: FFT_SIZE,
    F_MIN: F_MIN,
    F_MAX: F_MAX,
    HOP_SEC: HOP_SEC,
    HALF_LIFE_SEC: HALF_LIFE_SEC,
    WARMUP_SEC: WARMUP_SEC,
    FINE_BINS: FINE_BINS,
    QUARTER_RATIO_MIN: QUARTER_RATIO_MIN,
    QUARTER_PEAK_MIN: QUARTER_PEAK_MIN,
    PERSIST_MIN: PERSIST_MIN,
    PROMINENCE_DB: PROMINENCE_DB,
    PEAK_RANGE_DB: PEAK_RANGE_DB,
    W_OFF: W_OFF,
  };
});
