import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tripId = process.argv[2] ?? "2025-07-16";
const configPath = path.join(projectRoot, "config", "trips", `${tripId}.json`);
const privateManifestPath = path.join(projectRoot, "public", "data", "trips", `${tripId}.json`);
const outputRoot = path.join(projectRoot, "dist-pages");
const mediaRoot = path.join(outputRoot, "media", tripId);
const releaseRoot = path.join(projectRoot, "dist-release-assets");

function stream(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function probe(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration,size", "-of", "json", file
  ], { maxBuffer: 1024 * 1024 });
  const format = JSON.parse(stdout).format ?? {};
  const duration = Number(format.duration);
  const size = Number(format.size);
  if (!Number.isFinite(duration) || !Number.isFinite(size)) throw new Error(`Could not probe ${file}`);
  return { duration, size };
}

async function precedingKeyframe(file, requested) {
  if (requested <= 0) return 0;
  const lookBehind = 12;
  const start = Math.max(0, requested - lookBehind);
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-skip_frame", "nokey", "-select_streams", "v:0",
    "-read_intervals", `${start}%+${lookBehind + 2}`,
    "-show_entries", "frame=pts_time", "-of", "csv=p=0", file
  ], { maxBuffer: 1024 * 1024 });
  const candidates = stdout.trim().split(/\s+/).map(Number).filter((value) => Number.isFinite(value) && value <= requested);
  if (!candidates.length) throw new Error(`No keyframe found before ${requested}s in ${file}`);
  return Math.max(...candidates);
}

async function mapLimited(values, limit, callback) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await callback(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function sourceRoot(config, sourceId) {
  const source = config.sources.find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error(`Missing source config: ${sourceId}`);
  return source;
}

async function splitVideo({ input, outputDirectory, prefix, startSeconds = 0, durationSeconds, maxBytes, targetBytes }) {
  await mkdir(outputDirectory, { recursive: true });
  const pattern = path.join(outputDirectory, `${prefix}-%03d.mp4`);
  const inputInfo = await probe(input);
  const selectedDuration = durationSeconds ?? Math.max(0, inputInfo.duration - startSeconds);
  const estimatedBytes = inputInfo.size / inputInfo.duration * selectedDuration;
  let segmentSeconds = estimatedBytes <= maxBytes
    ? selectedDuration + 1
    : Math.max(1, selectedDuration * targetBytes / estimatedBytes);

  for (let attempt = 1; attempt <= 6; attempt++) {
    const oldNames = (await readdir(outputDirectory)).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".mp4"));
    await Promise.all(oldNames.map((name) => rm(path.join(outputDirectory, name))));
    const args = ["-hide_banner", "-loglevel", "error", "-y"];
    if (startSeconds > 0) args.push("-ss", startSeconds.toFixed(6));
    args.push("-i", input);
    if (durationSeconds != null) args.push("-t", durationSeconds.toFixed(6));
    args.push(
      "-map", "0", "-c", "copy", "-f", "segment", "-segment_time", segmentSeconds.toFixed(3),
      "-reset_timestamps", "1", "-segment_format", "mp4",
      "-segment_format_options", "movflags=+faststart", pattern
    );
    await stream("ffmpeg", args);
    const names = (await readdir(outputDirectory)).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".mp4")).sort();
    const pieces = await Promise.all(names.map(async (name) => ({ name, ...(await probe(path.join(outputDirectory, name))) })));
    const largest = Math.max(...pieces.map((piece) => piece.size));
    if (largest <= maxBytes) {
      console.log(`  ${prefix}: ${pieces.length} piece${pieces.length === 1 ? "" : "s"}, target ${segmentSeconds.toFixed(1)}s, largest ${(largest / 1024 / 1024).toFixed(1)} MiB`);
      return pieces;
    }
    segmentSeconds = Math.max(1, segmentSeconds * targetBytes / largest * 0.98);
  }
  throw new Error(`Could not split ${input} below ${(maxBytes / 1024 / 1024).toFixed(1)} MiB`);
}

function makeVideoItems(sourceId, pieces, start, fadeSeconds, namePrefix, urlForPiece) {
  let cursor = start;
  return pieces.map((piece, index) => {
    const pieceStart = cursor;
    cursor += piece.duration * 1000;
    const isLast = index === pieces.length - 1;
    return {
      id: `${sourceId}:${namePrefix}:${index}`,
      name: piece.name,
      type: "video",
      start: pieceStart,
      contentEnd: cursor,
      end: cursor + (isLast ? fadeSeconds * 1000 : 0),
      rawStart: pieceStart,
      duration: piece.duration,
      url: urlForPiece(piece)
    };
  });
}

const config = JSON.parse(await readFile(configPath, "utf8"));
if (!config.publishRange || !config.publish) throw new Error(`${tripId} needs publishRange and publish settings`);

await stream(process.execPath, [path.join(projectRoot, "scripts", "build-manifest.js"), tripId]);
const privateManifest = JSON.parse(await readFile(privateManifestPath, "utf8"));
const publicStart = privateManifest.publishRange.start;
const publicEnd = privateManifest.publishRange.end;
const maxBytes = config.publish.maxFileMiB * 1024 * 1024;
const targetBytes = config.publish.targetFileMiB * 1024 * 1024;
const release = config.publish.release ?? null;
const videoMaxBytes = (release?.maxFileMiB ?? config.publish.maxFileMiB) * 1024 * 1024;
const videoTargetBytes = (release?.targetFileMiB ?? config.publish.targetFileMiB) * 1024 * 1024;
const releaseBaseUrl = release
  ? `https://github.com/${release.repository}/releases/download/${encodeURIComponent(release.tag)}`
  : null;

await rm(outputRoot, { recursive: true, force: true });
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "data", "trips"), { recursive: true });
if (release) await mkdir(releaseRoot, { recursive: true });
for (const name of ["index.html", "app.css", "app.js"]) await copyFile(path.join(projectRoot, "public", name), path.join(outputRoot, name));
await writeFile(path.join(outputRoot, ".nojekyll"), "");

const publicSources = [];
for (const source of privateManifest.sources) {
  const sourceConfig = sourceRoot(config, source.id);
  const outputDirectory = path.join(mediaRoot, source.id);
  const videoOutputDirectory = release ? releaseRoot : outputDirectory;
  const videoUrl = (piece) => release
    ? `${releaseBaseUrl}/${encodeURIComponent(piece.name)}`
    : `media/${encodeURIComponent(tripId)}/${encodeURIComponent(source.id)}/${encodeURIComponent(piece.name)}`;
  await mkdir(outputDirectory, { recursive: true });
  const outputItems = [];

  if (source.kind === "continuous") {
    for (let index = 0; index < source.items.length; index++) {
      const item = source.items[index];
      const effectiveEnd = Math.min(item.end, source.items[index + 1]?.start ?? Infinity, publicEnd);
      const selectedStart = Math.max(item.start, publicStart);
      if (selectedStart >= effectiveEnd) continue;
      const requestedLocalStart = (selectedStart - item.start) / 1000;
      const input = path.join(sourceConfig.root, item.name);
      const alignedLocalStart = await precedingKeyframe(input, requestedLocalStart);
      const alignedMasterStart = item.start + alignedLocalStart * 1000;
      const duration = (effectiveEnd - alignedMasterStart) / 1000;
      const basePrefix = `${String(index).padStart(2, "0")}-${path.parse(item.name).name}`;
      const prefix = release ? `${source.id}-${basePrefix}` : basePrefix;
      console.log(`${source.id}: clipping ${item.name}`);
      const pieces = await splitVideo({
        input, outputDirectory: videoOutputDirectory, prefix, startSeconds: alignedLocalStart,
        durationSeconds: duration, maxBytes: videoMaxBytes, targetBytes: videoTargetBytes
      });
      outputItems.push(...makeVideoItems(source.id, pieces, alignedMasterStart, 0, prefix, videoUrl));
    }
  } else {
    const selected = source.items.filter((item) => item.start < publicEnd && item.end > publicStart);
    const images = selected.filter((item) => item.type === "image");
    const videos = selected.filter((item) => item.type === "video");
    console.log(`${source.id}: downsampling ${images.length} stills`);
    const imageItems = await mapLimited(images, config.publish.imageWorkers, async (item) => {
      const outputName = `${path.parse(item.name).name}.jpg`;
      await stream("magick", [
        "-define", `${"jpeg:size"}=${config.publish.imageMax.split("x")[0]}x${config.publish.imageMax.split("x")[0]}`,
        path.join(sourceConfig.root, item.name), "-auto-orient", "-thumbnail", `${config.publish.imageMax}>`,
        "-strip", "-quality", String(config.publish.jpegQuality), path.join(outputDirectory, outputName)
      ]);
      return { ...item, name: outputName, url: `media/${encodeURIComponent(tripId)}/${encodeURIComponent(source.id)}/${encodeURIComponent(outputName)}` };
    });
    outputItems.push(...imageItems);

    for (let index = 0; index < videos.length; index++) {
      const item = videos[index];
      const basePrefix = `${String(index).padStart(2, "0")}-${path.parse(item.name).name}`;
      const prefix = release ? `${source.id}-${basePrefix}` : basePrefix;
      console.log(`${source.id}: splitting ${item.name}`);
      const pieces = await splitVideo({
        input: path.join(sourceConfig.root, item.name), outputDirectory: videoOutputDirectory, prefix,
        durationSeconds: item.duration, maxBytes: videoMaxBytes, targetBytes: videoTargetBytes
      });
      outputItems.push(...makeVideoItems(source.id, pieces, item.start, source.fadeSeconds, prefix, videoUrl));
    }
  }

  outputItems.sort((a, b) => a.start - b.start);
  publicSources.push({ ...source, items: outputItems });
}

async function collect(directory, results = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file, results);
    else results.push({ file, ...(await stat(file)) });
  }
  return results;
}
const pagesMediaFiles = await collect(mediaRoot);
const releaseFiles = release ? await collect(releaseRoot) : [];
const oversized = pagesMediaFiles.filter((entry) => entry.size > maxBytes);
if (oversized.length) throw new Error(`Files exceed ${config.publish.maxFileMiB} MiB:\n${oversized.map((entry) => entry.file).join("\n")}`);
const oversizedRelease = releaseFiles.filter((entry) => entry.size > videoMaxBytes);
if (oversizedRelease.length) throw new Error(`Release files exceed ${release.maxFileMiB} MiB:\n${oversizedRelease.map((entry) => entry.file).join("\n")}`);

const publicManifest = {
  ...privateManifest,
  start: publicStart,
  end: publicEnd,
  initialTime: publicStart,
  publishRange: { start: publicStart, end: publicEnd },
  generatedAt: new Date().toISOString(),
  warnings: [],
  sources: publicSources
};
await writeFile(path.join(outputRoot, "data", "trips", `${tripId}.json`), `${JSON.stringify(publicManifest, null, 2)}\n`);
await writeFile(path.join(outputRoot, "data", "trips", "index.json"), `${JSON.stringify([tripId])}\n`);

const pagesBytes = pagesMediaFiles.reduce((sum, entry) => sum + entry.size, 0);
const releaseBytes = releaseFiles.reduce((sum, entry) => sum + entry.size, 0);
console.log(`Built ${outputRoot}`);
console.log(`Pages: ${pagesMediaFiles.length} media files, ${(pagesBytes / 1024 / 1024).toFixed(1)} MiB`);
if (release) console.log(`Release: ${releaseFiles.length} video files, ${(releaseBytes / 1024 / 1024).toFixed(1)} MiB, largest ${(Math.max(...releaseFiles.map((entry) => entry.size)) / 1024 / 1024).toFixed(1)} MiB`);
