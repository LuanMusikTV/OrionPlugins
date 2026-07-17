// tensor-art.js — Ørion Gallery Plugin
// Downloads images from Tensor.Art

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";
const API_BASE = "https://tensor.art/api/v1";

module.exports = {
  name: "Tensor.Art",
  version: "1.0.0",
  description: "Downloads images from Tensor.Art — AI art sharing platform",
  author: "LuanMusikTV",
  domains: ["tensor.art"],
  homepage: "https://tensor.art",

  canHandle(url) {
    return url.includes("tensor.art/images/") || url.includes("tensor.art/u/");
  },

  async probe(url, ctx) {
    ctx.log(`[Tensor.Art] Probing: ${url}`);
    if (url.includes("/images/")) {
      return probeImage(url, ctx);
    }
    return probeUser(url, ctx);
  },

  async getFiles(url, ctx) {
    ctx.log(`[Tensor.Art] Getting files: ${url}`);
    if (url.includes("/images/")) {
      return getImageFiles(url, ctx);
    }
    return getUserFiles(url, ctx);
  },
};

async function probeImage(url, ctx) {
  const imageId = url.split("/images/")[1].split(/[?/#]/)[0];
  const html = await fetchHtml(url, ctx);
  const title = extractMeta(html, "og:title") || `tensor-art-${imageId}`;
  const previewUrl = extractMeta(html, "og:image");
  return {
    title,
    siteName: "Tensor.Art",
    fileCount: 1,
    previewUrls: previewUrl ? [previewUrl] : [],
  };
}

async function getImageFiles(url, ctx) {
  const imageId = url.split("/images/")[1].split(/[?/#]/)[0];
  ctx.log(`[Tensor.Art] Fetching image ${imageId}`);
  const html = await fetchHtml(url, ctx);
  const ogImage = extractMeta(html, "og:image");
  const title = extractMeta(html, "og:title") || imageId;
  if (!ogImage) throw new Error("Could not extract image URL from page");

  const originalUrl = ogImage.replace(/\/w\/\d+\//, "/w/0/").replace(/\?.*$/, "");
  const ext = getExt(originalUrl);
  return [
    {
      url: originalUrl,
      filename: `${sanitize(title)}_${imageId}.${ext}`,
      headers: { "User-Agent": USER_AGENT, Referer: "https://tensor.art" },
    },
  ];
}

async function probeUser(url, _ctx) {
  const username = url.split("/u/")[1].split(/[?/#]/)[0];
  return {
    title: `${username} — Tensor.Art`,
    artist: username,
    siteName: "Tensor.Art",
  };
}

async function getUserFiles(url, ctx) {
  const username = url.split("/u/")[1].split(/[?/#]/)[0];
  ctx.log(`[Tensor.Art] Fetching gallery for: ${username}`);
  const files = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const apiUrl = `${API_BASE}/posts?username=${encodeURIComponent(username)}&page=${page}&limit=50`;
    const response = await fetch(apiUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: ctx.signal,
    });

    if (!response.ok) {
      ctx.log(`[Tensor.Art] API unavailable (${response.status}), stopping pagination`);
      break;
    }

    const data = await response.json();
    const items = data.items || data.posts || data.data || [];
    for (const item of items) {
      const imgUrl = item.imageUrl || item.url || item.image;
      if (imgUrl) {
        const ext = getExt(imgUrl);
        files.push({
          url: imgUrl,
          filename: `${username}/${item.id || files.length + 1}.${ext}`,
          headers: { "User-Agent": USER_AGENT, Referer: "https://tensor.art" },
        });
      }
    }

    hasMore = items.length === 50;
    page += 1;
    ctx.log(`[Tensor.Art] ${files.length} images so far...`);
  }

  return files;
}

async function fetchHtml(url, ctx) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: ctx.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

function extractMeta(html, property) {
  const match =
    html.match(
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`,
        "i",
      ),
    ) ||
    html.match(
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`,
        "i",
      ),
    );
  return match ? match[1].trim() : null;
}

function getExt(url) {
  const match = url.split("?")[0].match(/\.(\w{2,4})$/);
  return match ? match[1].toLowerCase() : "jpg";
}

function sanitize(name) {
  return (name || "image").replace(/[<>:"/\\|?*]/g, "_").trim().slice(0, 100);
}
