import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const roots = new Map([
  ["2024", "/mnt/c/photos/2024/2024 Glasses"],
  ["2025", "/mnt/c/photos/2025/2025 Glasses"],
  ["2026", "/mnt/c/photos/2026/2026 Glasses"]
]);
const localParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});

function filenameTime(name) {
  const match = name.match(/^(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)_/);
  if (!match) throw new Error("unsupported filename");
  return Date.UTC(...match.slice(1).map(Number).map((value, index) => index === 1 ? value - 1 : value));
}

function exifTime(value) {
  const match = value.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
  if (!match) throw new Error("missing DateTimeOriginal");
  return Date.UTC(...match.slice(1).map(Number).map((entry, index) => index === 1 ? entry - 1 : entry));
}

function utcAsLocalTime(value) {
  const values = Object.fromEntries(localParts.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return Date.UTC(+values.year, +values.month - 1, +values.day, +values.hour, +values.minute, +values.second);
}

async function inspect(root, name) {
  const file = path.join(root, name);
  const filename = filenameTime(name);
  if (/\.jpe?g$/i.test(name)) {
    const { stdout } = await run("magick", ["identify", "-quiet", "-ping", "-format", "%[EXIF:DateTimeOriginal]", file], { maxBuffer: 1024 * 1024 });
    return { name, type: "photo", filename, stamp: exifTime(stdout.trim()) };
  }
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:format_tags=creation_time", "-of", "json", file
  ], { maxBuffer: 1024 * 1024 });
  const format = JSON.parse(stdout).format ?? {};
  const duration = Number(format.duration) * 1000;
  const creation = Date.parse(format.tags?.creation_time);
  if (!Number.isFinite(duration) || !Number.isFinite(creation)) throw new Error("missing duration or creation_time");
  return { name, type: "video", filename, stamp: utcAsLocalTime(creation), duration };
}

async function mapLimited(values, limit, callback) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      try { results[index] = await callback(values[index]); }
      catch (error) { results[index] = { name: values[index], error: error.message }; }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function stats(values) {
  if (!values.length) return "n/a";
  const sorted = values.toSorted((a, b) => a - b);
  const pick = (fraction) => sorted[Math.floor((sorted.length - 1) * fraction)] / 1000;
  return `min ${pick(0).toFixed(3)}s, median ${pick(.5).toFixed(3)}s, p95 ${pick(.95).toFixed(3)}s, max ${pick(1).toFixed(3)}s`;
}

function overlapCount(photos, videos, startForVideo) {
  return photos.filter((photo) => videos.some((video) => {
    const start = startForVideo(video);
    return photo.stamp >= start && photo.stamp < start + video.duration;
  })).length;
}

function report(label, values) {
  const valid = values.filter((value) => !value.error);
  const photos = valid.filter((value) => value.type === "photo");
  const videos = valid.filter((value) => value.type === "video");
  console.log(`\n${label}: ${photos.length} photos, ${videos.length} videos, ${values.length - valid.length} unreadable`);
  console.log(`  photo EXIF − filename:             ${stats(photos.map((item) => item.stamp - item.filename))}`);
  console.log(`  video creation_time − filename:    ${stats(videos.map((item) => item.stamp - item.filename))}`);
  console.log(`  (creation_time − duration) − name: ${stats(videos.map((item) => item.stamp - item.duration - item.filename))}`);
  console.log(`  photo overlaps if video starts at filename:      ${overlapCount(photos, videos, (video) => video.filename)}`);
  console.log(`  photo overlaps if video starts at creation_time: ${overlapCount(photos, videos, (video) => video.stamp)}`);
  console.log(`  photo overlaps if creation_time is video end:    ${overlapCount(photos, videos, (video) => video.stamp - video.duration)}`);
  const photoOutliers = photos.filter((item) => Math.abs(item.stamp - item.filename) >= 60_000);
  const videoOutliers = videos.filter((item) => Math.abs(item.stamp - item.duration - item.filename) >= 60_000);
  for (const item of photoOutliers.slice(0, 10)) console.log(`  photo outlier: ${item.name}: EXIF − filename = ${((item.stamp - item.filename) / 1000).toFixed(3)}s`);
  for (const item of videoOutliers.slice(0, 10)) console.log(`  video outlier: ${item.name}: inferred start − filename = ${((item.stamp - item.duration - item.filename) / 1000).toFixed(3)}s`);
  for (const failure of values.filter((value) => value.error).slice(0, 5)) console.log(`  unreadable: ${failure.name}: ${failure.error}`);
}

for (const [year, root] of roots) {
  let names;
  try {
    names = (await readdir(root)).filter((name) => /^20\d{6}_\d{6}_[a-f0-9]+\.(jpg|mp4)$/i.test(name)).sort();
  } catch (error) {
    console.log(`\n${year}: no Glasses directory at ${root}`);
    continue;
  }
  console.log(`${year}: inspecting ${names.length} files…`);
  const values = await mapLimited(names, 8, (name) => inspect(root, name));
  report(year, values);
  if (year === "2025") report("2025-07-16 only", values.filter((value) => value.name.startsWith("20250716_")));
}
