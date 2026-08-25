import { execFile } from "node:child_process";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configDir = path.join(projectRoot, "config", "trips");
const outputDir = path.join(projectRoot, "public", "data", "trips");
const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const run = promisify(execFile);

function localIso(value, offset) {
  if (!value) throw new Error("missing timestamp");
  const normalized = value.replace(/^(\d{4}):(\d\d):(\d\d) (\d\d:\d\d:\d\d).*$/, "$1-$2-$3T$4");
  if (/Z$|[+-]\d\d:\d\d$/.test(normalized)) return normalized;
  return `${normalized}${offset}`;
}

function filenameTimestamp(name, offset) {
  const match = name.match(/(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)/);
  if (!match) throw new Error("filename has no supported timestamp");
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${offset}`;
}

async function ffprobe(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:format_tags=creation_time",
    "-of", "json", file
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  const format = JSON.parse(stdout).format ?? {};
  const duration = Number(format.duration);
  if (!Number.isFinite(duration)) throw new Error("media has no readable duration");
  return { duration, creationTime: format.tags?.creation_time };
}

async function exifTimestamp(file) {
  const { stdout } = await run("magick", ["identify", "-quiet", "-ping", "-format", "%[EXIF:DateTimeOriginal]", file], {
    encoding: "utf8", maxBuffer: 1024 * 1024
  });
  const value = stdout.trim();
  if (!value) throw new Error("photo has no EXIF DateTimeOriginal");
  return value;
}

function correctClock(rawMs, sync) {
  const anchorMs = Date.parse(sync.anchor);
  return anchorMs + (rawMs - anchorMs) / sync.clockRate + sync.offsetSeconds * 1000;
}

function rangeBoundary(sources, rule, edge) {
  if (rule.timestamp) {
    const timestamp = Date.parse(rule.timestamp);
    if (!Number.isFinite(timestamp)) throw new Error(`range ${edge} has an invalid timestamp`);
    return timestamp;
  }
  const sourceIds = new Set(rule.sourceIds);
  const mediaTypes = rule.mediaTypes ? new Set(rule.mediaTypes) : null;
  const items = sources
    .filter((source) => sourceIds.has(source.id))
    .flatMap((source) => source.items)
    .filter((item) => !mediaTypes || mediaTypes.has(item.type));
  if (!items.length) throw new Error(`range ${edge} rule matched no media`);
  const values = items.map((item) => item.start);
  return (edge === "start" ? Math.min(...values) : Math.max(...values)) + (rule.shiftSeconds ?? 0) * 1000;
}

async function buildTrip(configPath) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const warnings = [];
  const sources = [];

  for (const source of config.sources) {
    const matcher = new RegExp(source.match, "i");
    const names = (await readdir(source.root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && matcher.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const items = [];

    for (const name of names) {
      const file = path.join(source.root, name);
      const extension = path.extname(name).toLowerCase();
      const mediaType = videoExtensions.has(extension) ? "video" : imageExtensions.has(extension) ? "image" : null;
      if (!mediaType) continue;

      try {
        let rawStart;
        let duration = 0;
        if (mediaType === "video") {
          const media = await ffprobe(file);
          duration = media.duration;
          const rule = source.timestamp.videos ?? source.timestamp;
          if (rule.type === "filename") rawStart = Date.parse(filenameTimestamp(name, config.timezoneOffset));
          else if (rule.type === "mediaEnd") rawStart = Date.parse(localIso(media.creationTime, config.timezoneOffset)) - duration * 1000;
          else throw new Error(`unsupported video timestamp rule: ${rule.type}`);
        } else {
          const rule = source.timestamp.photos ?? source.timestamp;
          if (rule.type !== "exif") throw new Error(`unsupported photo timestamp rule: ${rule.type}`);
          rawStart = Date.parse(localIso(await exifTimestamp(file), config.timezoneOffset));
          duration = source.photoHoldSeconds;
        }
        if (!Number.isFinite(rawStart)) throw new Error("timestamp could not be parsed");
        const start = correctClock(rawStart, source.sync);
        const fadeDuration = source.kind === "events" ? source.fadeSeconds ?? 0.6 : 0;
        items.push({
          id: `${source.id}:${name}`,
          name,
          type: mediaType,
          start,
          contentEnd: start + duration * 1000,
          end: start + (duration + fadeDuration) * 1000,
          rawStart,
          duration,
          url: `media/${encodeURIComponent(config.id)}/${encodeURIComponent(source.id)}/${encodeURIComponent(name)}`
        });
      } catch (error) {
        warnings.push(`${source.id}/${name}: ${error.message}`);
      }
    }

    items.sort((a, b) => a.start - b.start);
    if (source.id === "glasses") {
      const videos = items.filter((item) => item.type === "video");
      for (const photo of items.filter((item) => item.type === "image")) {
        const video = videos.find((item) => photo.start >= item.start && photo.start < item.contentEnd);
        if (video) warnings.push(`glasses overlap: ${photo.name} occurs during ${video.name}`);
      }
    }
    sources.push({
      id: source.id,
      label: source.label,
      kind: source.kind,
      photoHoldSeconds: source.photoHoldSeconds ?? 1,
      fadeSeconds: source.fadeSeconds ?? 0.6,
      sync: source.sync,
      items
    });
  }

  const allItems = sources.flatMap((source) => source.items);
  if (!allItems.length) throw new Error(`${config.id}: no readable media found\n${warnings.slice(0, 12).join("\n")}`);
  const start = config.range?.start
    ? rangeBoundary(sources, config.range.start, "start")
    : Math.min(...allItems.map((item) => item.start));
  const end = config.range?.end
    ? rangeBoundary(sources, config.range.end, "end")
    : Math.max(...allItems.map((item) => item.end));
  if (end <= start) throw new Error(`${config.id}: configured range ends before it starts`);
  const initialTime = config.initialTime ? Date.parse(config.initialTime) : start;
  if (!Number.isFinite(initialTime) || initialTime < start || initialTime > end) {
    throw new Error(`${config.id}: initialTime must fall inside the configured range`);
  }
  const publishRange = config.publishRange ? {
    start: rangeBoundary(sources, config.publishRange.start, "publish start"),
    end: rangeBoundary(sources, config.publishRange.end, "publish end")
  } : null;
  if (publishRange && (publishRange.end <= publishRange.start || publishRange.start < start || publishRange.end > end)) {
    throw new Error(`${config.id}: publishRange must be ordered and contained within the private range`);
  }
  const manifest = {
    id: config.id,
    title: config.title,
    timezoneOffset: config.timezoneOffset,
    start,
    end,
    initialTime,
    publishRange,
    generatedAt: new Date().toISOString(),
    warnings,
    sources
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, `${config.id}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const requested = process.argv.slice(2);
const configs = (await readdir(configDir))
  .filter((name) => name.endsWith(".json") && (!requested.length || requested.includes(path.basename(name, ".json"))))
  .sort();

for (const name of configs) {
  const manifest = await buildTrip(path.join(configDir, name));
  console.log(`${manifest.id}: ${manifest.sources.map((source) => `${source.id}=${source.items.length}`).join(", ")}`);
  for (const warning of manifest.warnings) console.warn(`  warning: ${warning}`);
}
await writeFile(path.join(outputDir, "index.json"), `${JSON.stringify(configs.map((name) => path.basename(name, ".json")))}\n`);
