# Hippo BTS

A local, four-source timeline for the hippo trips. It uses native browser media decoding and a generated manifest; source media is never copied into this project.

## Run

```bash
cd /home/lucent/hippo-bts
npm run manifest
npm start
```

Open <http://127.0.0.1:8080>. Space toggles playback, arrow keys move five seconds, and Shift+arrow moves one minute.

## Build the public Pages package

```bash
npm run build:pages -- 2025-07-16
npm run preview:pages
```

The build writes `dist-pages/`, uses the trip's separate `publishRange`, downsamples stills, and writes a static manifest. When `publish.release` is configured, videos are stream-copied with fast-start indexes into `dist-release-assets/` and manifest URLs point to the pinned GitHub Release. Otherwise videos are adaptively split under the Pages file limit. Preview the Pages output at <http://127.0.0.1:8081>.

For the 2025 trip, the Pages site is published from `gh-pages` while video assets live in the public `hippos-2025-v1` GitHub Release. Release URLs are version-pinned in the generated manifest.

To compare Glasses filename, EXIF, and QuickTime timestamps across years:

```bash
npm run audit:glasses
```

## Add another trip

Copy `config/trips/2025-07-16.json`, change the trip ID, roots, filename matchers, timestamp rules, and source anchors, then run `npm run manifest` again.

`offsetSeconds` is the expected correction control. Leave `clockRate` at `1` unless visual anchors show real clock drift. A rate above 1 means the source clock ran fast relative to the reference clock.

Each trip can define fixed or source-relative timeline boundaries. The 2025 trip begins at 10:15 AM and ends one minute after its last Zoo still photo.
Its `initialTime` places the playhead at 10:48 AM when the page opens.
Its separate `publishRange` limits a future public/Pages export to 10:48–11:00 without shortening the private viewer.

Glasses photos use EXIF `DateTimeOriginal`. Glasses videos use QuickTime `creation_time` as the recording end and subtract the probed clip duration. The builder warns if a Glasses photo lands inside a Glasses video.

Still photos hold for three seconds before fading. A new event in the same quadrant replaces the current still immediately.
