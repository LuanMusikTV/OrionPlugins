// civitai.js — Ørion Gallery Plugin
// Supports: civitai.com/models/* and civitai.com/user/*/images

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";

module.exports = {
  name: "Civitai",
  version: "1.0.0",
  description: "Downloads models, images and previews from Civitai",
  author: "LuanMusikTV",
  domains: ["civitai.com"],
  homepage: "https://civitai.com",

  canHandle(url) {
    return url.includes("civitai.com/models/") || url.includes("civitai.com/user/");
  },

  async probe(url, ctx) {
    ctx.log(`[Civitai] Probing: ${url}`);
    return url.includes("/models/") ? probeModel(url, ctx) : probeUserImages(url, ctx);
  },

  async getFiles(url, ctx) {
    ctx.log(`[Civitai] Getting files for: ${url}`);
    return url.includes("/models/") ? getModelFiles(url, ctx) : getUserImageFiles(url, ctx);
  },
};

async function probeModel(url, ctx) {
  const modelId = url.split("/models/")[1].split(/[/?]/)[0];
  const data = await fetchJson(`https://civitai.com/api/v1/models/${modelId}`, ctx);
  return {
    title: data.name,
    artist: data.creator?.username,
    siteName: "Civitai",
    tags: (data.tags || []).slice(0, 5),
    fileCount: (data.modelVersions || []).reduce(
      (acc, version) => acc + (version.files?.length || 0) + Math.min(5, version.images?.length || 0),
      0,
    ),
  };
}

async function getModelFiles(url, ctx) {
  const modelId = url.split("/models/")[1].split(/[/?]/)[0];
  ctx.log(`[Civitai] Fetching model ${modelId}`);
  const data = await fetchJson(`https://civitai.com/api/v1/models/${modelId}`, ctx);
  const files = [];

  for (const version of data.modelVersions || []) {
    const dir = sanitize(version.name || `version-${version.id || "unknown"}`);

    for (const file of version.files || []) {
      files.push({
        url: file.downloadUrl || `https://civitai.com/api/download/models/${file.id || version.id}`,
        filename: `${dir}/${file.name}`,
        headers: { "User-Agent": USER_AGENT },
      });
    }

    const previews = (version.images || []).slice(0, 5);
    previews.forEach((img, index) => {
      const resolvedUrl = resolveImageUrl(img.url);
      const ext = getImageExtension(resolvedUrl, img.mimeType);
      files.push({
        url: resolvedUrl,
        filename: `${dir}/previews/preview_${String(index + 1).padStart(3, "0")}.${ext}`,
        headers: { "User-Agent": USER_AGENT },
      });
    });
  }

  ctx.log(`[Civitai] ${files.length} files across ${(data.modelVersions || []).length} versions`);
  return files;
}

async function probeUserImages(url, _ctx) {
  const username = url.split("/user/")[1].split("/")[0];
  return { title: `${username} — Civitai`, artist: username, siteName: "Civitai" };
}

async function getUserImageFiles(url, ctx) {
  const username = url.split("/user/")[1].split("/")[0];
  const files = [];
  let cursor = null;

  while (true) {
    const params = new URLSearchParams({
      browsingLevel: "31",
      period: "AllTime",
      sort: "Newest",
      username,
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    const data = await fetchJson(`https://civitai.com/api/v1/images?${params.toString()}`, ctx);

    for (const img of data.items || []) {
      const resolvedUrl = resolveImageUrl(img.url);
      const ext = getImageExtension(resolvedUrl, img.mimeType);
      files.push({
        url: resolvedUrl,
        filename: `${img.id}.${ext}`,
        headers: { "User-Agent": USER_AGENT },
      });
    }

    cursor = data.metadata?.nextCursor || null;
    if (!cursor) {
      break;
    }

    ctx.log(`[Civitai] ${files.length} images fetched...`);
  }

  return files;
}

async function fetchJson(url, ctx) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: ctx.signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response.json();
}

function resolveImageUrl(url) {
  if (typeof url !== "string" || !url) {
    return "";
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  const normalizedPath = url.startsWith("/") ? url.slice(1) : url;
  return `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${normalizedPath}/original=true/`;
}

function getImageExtension(url, mimeType) {
  if (typeof mimeType === "string" && mimeType.includes("/")) {
    const candidate = mimeType.split("/")[1];
    if (candidate) {
      return candidate;
    }
  }

  const withoutQuery = (url.split("?")[0] || "").replace(/\/$/, "");
  const lastSegment = withoutQuery.split("/").pop() || "";
  const candidate = lastSegment.split(".").pop() || "jpg";
  return candidate.toLowerCase();
}

function sanitize(name) {
  return String(name).replace(/[<>:"/\\|?*]/g, "_").trim().slice(0, 100);
}
