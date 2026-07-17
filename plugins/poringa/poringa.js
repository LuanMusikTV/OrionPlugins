// poringa.js — Ørion Gallery Plugin
// Downloads images from individual Poringa.net posts

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";

module.exports = {
  name: "Poringa",
  version: "1.0.0",
  description: "Downloads images from individual Poringa.net posts",
  author: "LuanMusikTV",
  domains: ["www.poringa.net", "poringa.net"],
  homepage: "https://www.poringa.net",

  canHandle(url) {
    return url.includes("poringa.net/posts/");
  },

  async probe(url, ctx) {
    ctx.log(`[Poringa] Probing: ${url}`);
    const html = await fetchHtml(url, ctx);
    const title = extractTitle(html);
    const images = extractImages(html);
    return {
      title,
      siteName: "Poringa",
      fileCount: images.length,
    };
  },

  async getFiles(url, ctx) {
    ctx.log(`[Poringa] Fetching post: ${url}`);
    const html = await fetchHtml(url, ctx);
    const title = extractTitle(html);
    const images = extractImages(html);
    ctx.log(`[Poringa] Found ${images.length} images in: ${title}`);

    return images.map((imgUrl, i) => {
      const ext = getExt(imgUrl);
      return {
        url: imgUrl,
        filename: `${sanitize(title)}/image_${String(i + 1).padStart(3, "0")}.${ext}`,
        headers: { "User-Agent": USER_AGENT, Referer: url },
      };
    });
  },
};

function extractTitle(html) {
  const ogTitle = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  if (ogTitle) return ogTitle[1].trim();

  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleTag) {
    return titleTag[1].replace(/\s*[-|]\s*Poringa.*$/i, "").trim();
  }

  return "poringa-post";
}

function extractImages(html) {
  const images = new Set();

  const ogImages = [
    ...html.matchAll(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi,
    ),
  ];
  ogImages.forEach((match) => images.add(match[1]));

  const imgTags = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)];
  imgTags.forEach((match) => {
    const src = match[1];
    if (src.includes("poringa") || src.includes("pblog") || src.includes("statics")) {
      if (
        !src.includes("avatar") &&
        !src.includes("thumb") &&
        !src.includes("icon") &&
        !src.includes("logo") &&
        (src.endsWith(".jpg") ||
          src.endsWith(".jpeg") ||
          src.endsWith(".png") ||
          src.endsWith(".gif") ||
          src.includes("/original/") ||
          src.includes("/full/"))
      ) {
        images.add(src);
      }
    }
  });

  return [...images];
}

async function fetchHtml(url, ctx) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "es-AR,es;q=0.9" },
    signal: ctx.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

function getExt(url) {
  const match = url.split("?")[0].match(/\.(\w{2,4})$/);
  return match ? match[1].toLowerCase() : "jpg";
}

function sanitize(name) {
  return (name || "post").replace(/[<>:"/\\|?*]/g, "_").trim().slice(0, 100);
}
