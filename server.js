import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = process.env.HIPPO_PUBLIC_ROOT ? path.resolve(root, process.env.HIPPO_PUBLIC_ROOT) : path.join(root, "public");
const sourceBackedMedia = !process.env.HIPPO_PUBLIC_ROOT;
const configRoot = path.join(root, "config", "trips");
const port = Number(process.env.PORT ?? 8080);
const mime = new Map([
  [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"], [".mov", "video/quicktime"], [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"], [".avif", "image/avif"]
]);

async function tripConfigs() {
  const result = new Map();
  for (const name of await readdir(configRoot)) {
    if (!name.endsWith(".json")) continue;
    const config = JSON.parse(await readFile(path.join(configRoot, name), "utf8"));
    result.set(config.id, config);
  }
  return result;
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function sendFile(request, response, file) {
  const info = await stat(file);
  const type = mime.get(path.extname(file).toLowerCase()) ?? "application/octet-stream";
  const common = {
    "content-type": type,
    "accept-ranges": "bytes",
    "last-modified": info.mtime.toUTCString(),
    "etag": `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`
  };
  const range = request.headers.range;
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) return response.writeHead(416).end();
    const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
    const start = suffixLength == null ? Number(match[1]) : Math.max(0, info.size - suffixLength);
    const end = suffixLength == null && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) return response.writeHead(416, { "content-range": `bytes */${info.size}` }).end();
    response.writeHead(206, {
      ...common, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}`
    });
    if (request.method === "HEAD") return response.end();
    createReadStream(file, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...common, "content-length": info.size });
  if (request.method === "HEAD") return response.end();
  createReadStream(file).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/api/trips") {
      const names = (await readdir(path.join(publicRoot, "data", "trips"))).filter((name) => name.endsWith(".json"));
      return sendJson(response, names.filter((name) => name !== "index.json").map((name) => path.basename(name, ".json")));
    }
    if (sourceBackedMedia && url.pathname.startsWith("/media/")) {
      const [, , encodedTrip, encodedSource, ...encodedName] = url.pathname.split("/");
      const trip = decodeURIComponent(encodedTrip);
      const sourceId = decodeURIComponent(encodedSource);
      const name = decodeURIComponent(encodedName.join("/"));
      if (name !== path.basename(name)) return response.writeHead(400).end("Invalid media path");
      const config = (await tripConfigs()).get(trip);
      const source = config?.sources.find((entry) => entry.id === sourceId);
      if (!source) return response.writeHead(404).end("Unknown media source");
      return await sendFile(request, response, path.join(source.root, name));
    }
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(publicRoot, relative);
    if (!file.startsWith(`${publicRoot}${path.sep}`)) return response.writeHead(403).end("Forbidden");
    await sendFile(request, response, file);
  } catch (error) {
    if (error.code === "ENOENT") return response.writeHead(404).end("Not found");
    console.error(error);
    response.writeHead(500).end("Server error");
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Hippo BTS: http://127.0.0.1:${port}`));
