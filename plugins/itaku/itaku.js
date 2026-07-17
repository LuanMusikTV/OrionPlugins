// itaku.js — Ørion Gallery Plugin
// Downloads images from Itaku.ee

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";
const API_BASE = "https://itaku.ee/api";

module.exports = {
  name: "Itaku",
  version: "1.0.0",
  description: "Downloads images from Itaku.ee — art sharing community",
  author: "LuanMusikTV",
  domains: ["itaku.ee"],
  homepage: "https://itaku.ee",

  canHandle(url) {
    return url.includes("itaku.ee/images/") || url.includes("itaku.ee/profile/");
  },

  async probe(url, ctx) {
    ctx.log(`[Itaku] Probing: ${url}`);
    if (url.includes("/images/")) {
      return probeSingleImage(url, ctx);
    }
    return probeGallery(url, ctx);
  },

  async getFiles(url, ctx) {
    ctx.log(`[Itaku] Getting files: ${url}`);
    if (url.includes("/images/")) {
      return getSingleImageFiles(url, ctx);
    }
    return getGalleryFiles(url, ctx);
  },
};

async function probeSingleImage(url, ctx) {
  const imageId = url.split("/images/")[1].split(/[?/#]/)[0];
  const data = await fetchJson(`${API_BASE}/galleries/images/${imageId}/`, ctx);
  return {
    title: data.title || `itaku-${imageId}`,
    artist: data.owner_username || data.owner,
    siteName: "Itaku",
    tags: (data.tags || []).slice(0, 5).map((tag) => tag.name || tag),
    fileCount: 1,
    previewUrls: data.image ? [data.image] : [],
  };
}

async function getSingleImageFiles(url, ctx) {
  const imageId = url.split("/images/")[1].split(/[?/#]/)[0];
  ctx.log(`[Itaku] Fetching image ${imageId}`);
  const data = await fetchJson(`${API_BASE}/galleries/images/${imageId}/`, ctx);
  const imgUrl = data.image || data.image_url;
  if (!imgUrl) throw new Error(`Could not find image URL for id: ${imageId}`);

  const ext = getExt(imgUrl);
  const title = sanitize(data.title || imageId);
  return [
    {
      url: imgUrl,
      filename: `${title}_${imageId}.${ext}`,
      headers: { "User-Agent": USER_AGENT, Referer: "https://itaku.ee" },
    },
  ];
}

async function probeGallery(url, _ctx) {
  const username = extractUsername(url);
  return {
    title: `${username} — Itaku`,
    artist: username,
    siteName: "Itaku",
  };
}

async function getGalleryFiles(url, ctx) {
  const username = extractUsername(url);
  ctx.log(`[Itaku] Fetching gallery for: ${username}`);
  const files = [];
  let nextUrl = `${API_BASE}/galleries/images/?owner=${encodeURIComponent(username)}&page_size=50&ordering=-date_added`;

  while (nextUrl) {
    const data = await fetchJson(nextUrl, ctx);
    for (const item of data.results || []) {
      const imgUrl = item.image || item.image_url;
      if (imgUrl) {
        const ext = getExt(imgUrl);
        const title = sanitize(item.title || String(item.id));
        files.push({
          url: imgUrl,
          filename: `${username}/${title}_${item.id}.${ext}`,
          headers: { "User-Agent": USER_AGENT, Referer: "https://itaku.ee" },
        });
      }
    }

    nextUrl = data.next || null;
    ctx.log(`[Itaku] ${files.length} images so far...`);
  }

  return files;
}

async function fetchJson(url, ctx) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: ctx.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

function extractUsername(url) {
  return url.split("/profile/")[1].split("/")[0];
}

function getExt(url) {
  const match = url.split("?")[0].match(/\.(\w{2,4})$/);
  return match ? match[1].toLowerCase() : "jpg";
}

function sanitize(name) {
  return (name || "image").replace(/[<>:"/\\|?*]/g, "_").trim().slice(0, 100);
}
