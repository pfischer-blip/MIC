# Contact Mic Live

A single-page web app for listening to a piezo contact microphone on an iPhone (or any browser).

- **Listen:** live waveform, spectrum, level meter, input gain, low cut, headphone monitoring, recording.
- **Timegrapher:** watch rate (s/day), amplitude, beat error, beat-rate auto-detect, and a six-position log with chart.

Open the GitHub Pages link in Safari, tap **Start listening**, and allow microphone access.
The timegrapher method follows the open-source [tg](https://github.com/vacaboja/tg) timegrapher.

## Phone Sonar (`/sonar/`)

A separate app that uses the phone's speaker and mic as sonar: it plays a short chirp ~20 times a second,
times the echo relative to the direct speaker-to-mic sound, and shows distance (m/ft/in) plus a Movement mode
that tracks moving objects and their approach/recede speed. Open `/sonar/` on the GitHub Pages site in Safari,
then Share → Add to Home Screen. `sonar/dev/test-sim.js` checks the math on simulated echoes (`node sonar/dev/test-sim.js`).
