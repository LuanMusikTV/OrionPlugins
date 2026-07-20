// poringa.js — Ørion Gallery Plugin
// Downloads images from Poringa.net posts and full user timelines.
//
// User profiles are often private (login wall). Like gallery-dl, user downloads
// are resolved through the public search endpoint `/buscar/?q={username}`.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";

const SITE_FOLDER = "Poringa";
const POST_PATH_RE = /\/posts\/([a-z]+)\/(\d+)(?:\/([^/?#]*))?/i;
// `/User`, `/User/`, `/User/posts`, `/User/posts/`
const USER_PATH_RE = /^\/([A-Za-z0-9_.-]{2,40})(?:\/posts)?\/?$/i;
const POST_ID_RE = /\/posts\/imagenes\/(\d+)/gi;
const RESERVED_USER_PATHS = new Set([
  "posts",
  "buscar",
  "videos",
  "shouts",
  "comunidades",
  "top",
  "directory",
  "tags",
  "rss",
  "registro-login",
  "registro",
  "login",
  "favicon.ico",
  "enciclopedia",
  "rand.php",
  "perfil",
]);

module.exports = {
  name: "Poringa",
  version: "1.2.2",
  description:
    "Downloads images from Poringa.net posts and complete user profiles (private posts need Auth cookies)",
  author: "LuanMusikTV",
  domains: ["www.poringa.net", "poringa.net"],
  homepage: "https://www.poringa.net",
  preferOverGalleryDl: true,

  canHandle(url) {
    return parseTarget(url) !== null;
  },

  async probe(url, ctx) {
    const target = parseTarget(url);
    if (!target) {
      throw new Error(`Unsupported Poringa URL: ${url}`);
    }

    if (target.kind === "post") {
      ctx.log(`[Poringa] Probing post ${target.postId}`);
      const fetched = await fetchHtml(absolutePostUrl(target), ctx);
      const meta = extractPostMeta(fetched.html, target, {
        finalUrl: fetched.finalUrl,
        hasCookies: Boolean(ctx.cookies),
      });
      return {
        title: meta.title,
        artist: meta.user,
        siteName: "Poringa",
        fileCount: meta.images.length,
        previewUrls: meta.images.slice(0, 3),
      };
    }

    ctx.log(`[Poringa] Probing user ${target.user}`);
    const postUrls = await listUserPostUrls(target.user, ctx, { maxPages: 1 });
    if (postUrls.length === 0) {
      throw new Error(
        `User "${target.user}" not found on Poringa (check the exact username)`,
      );
    }

    return {
      title: `${capitalize(target.user)} — Poringa`,
      artist: capitalize(target.user),
      siteName: "Poringa",
      fileCount: postUrls.length,
    };
  },

  async getFiles(url, ctx) {
    const target = parseTarget(url);
    if (!target) {
      throw new Error(`Unsupported Poringa URL: ${url}`);
    }

    if (target.kind === "post") {
      return getPostFiles(target, ctx);
    }

    return getUserFiles(target.user, ctx);
  },
};

async function getPostFiles(target, ctx) {
  const postUrl = absolutePostUrl(target);
  ctx.log(`[Poringa] Fetching post: ${postUrl}`);
  const fetched = await fetchHtml(postUrl, ctx);
  const meta = extractPostMeta(fetched.html, target, {
    finalUrl: fetched.finalUrl,
    hasCookies: Boolean(ctx.cookies),
  });
  ctx.log(
    `[Poringa] Found ${meta.images.length} images in "${meta.title}" by ${meta.user}`,
  );
  return buildFileEntries(meta, postUrl);
}

async function getUserFiles(username, ctx) {
  ctx.log(
    `[Poringa] Listing posts for user: ${username} (via public search; profiles often require login)`,
  );
  const postUrls = await listUserPostUrls(username, ctx);
  if (postUrls.length === 0) {
    throw new Error(
      `User "${username}" not found on Poringa (check the exact username)`,
    );
  }
  ctx.log(`[Poringa] ${postUrls.length} posts found for ${username}`);

  const files = [];
  for (const postUrl of postUrls) {
    if (ctx.signal.aborted) {
      throw new Error("Operation canceled");
    }

    const parsed = parseTarget(postUrl);
    if (!parsed || parsed.kind !== "post") {
      continue;
    }

    try {
      const fetched = await fetchHtml(postUrl, ctx);
      const meta = extractPostMeta(fetched.html, parsed, {
        finalUrl: fetched.finalUrl,
        hasCookies: Boolean(ctx.cookies),
      });
      // Prefer the profile username for a stable folder name.
      meta.user = capitalize(username);
      const entries = buildFileEntries(meta, postUrl);
      files.push(...entries);
      ctx.log(
        `[Poringa] ${files.length} images so far (post ${parsed.postId})`,
      );
      ctx.onProgress({
        completedFiles: 0,
        totalFiles: files.length,
        currentFile: meta.title,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(`[Poringa] Skipping post ${parsed.postId}: ${message}`);
    }
  }

  return files;
}

function buildFileEntries(meta, referer) {
  const userFolder = capitalize(meta.user);
  const titlePart = sanitize(meta.title) || "post";

  return meta.images.map((imgUrl, index) => {
    const ext = getExt(imgUrl);
    const stem = sanitize(getStem(imgUrl)) || "img";
    const num = String(index + 1).padStart(3, "0");
    const filename = `${SITE_FOLDER}/${userFolder}/${meta.postId}_${titlePart}_${num}_${stem}.${ext}`;
    return {
      url: imgUrl,
      filename,
      headers: { "User-Agent": USER_AGENT, Referer: referer },
    };
  });
}

function privatePostError(postId, hasCookies) {
  if (hasCookies) {
    return new Error(
      `Private post ${postId}: login required (cookies rejected or session expired — update Auth for poringa.net)`,
    );
  }
  return new Error(
    `Private post ${postId}: login required — configure a cookies.txt for poringa.net in Auth`,
  );
}

function isPrivatePostResponse(html, finalUrl) {
  if (/\/registro-login\?/i.test(finalUrl) && /private=post/i.test(finalUrl)) {
    return true;
  }
  return /\/registro-login\?/i.test(html) && /private=post/i.test(html);
}

function extractPostMeta(html, target, options = {}) {
  if (isPrivatePostResponse(html, options.finalUrl || "")) {
    throw privatePostError(target.postId, Boolean(options.hasCookies));
  }

  const title = extractTitle(html) || target.slug || `post-${target.postId}`;
  const user =
    extractUsername(html) ||
    extractUsernameFromImages(html) ||
    "Unknown";
  const images = extractImages(html, user);

  return {
    postId: target.postId,
    title,
    user,
    images,
  };
}

async function listUserPostUrls(username, ctx, options = {}) {
  const maxPages = options.maxPages ?? 50;
  const found = new Set();

  for (let page = 1; page <= maxPages; page += 1) {
    if (ctx.signal.aborted) {
      throw new Error("Operation canceled");
    }

    const searchUrl = `https://www.poringa.net/buscar/?q=${encodeURIComponent(username)}&p=${page}`;
    ctx.log(`[Poringa] Search page ${page}: ${searchUrl}`);

    let fetched;
    try {
      fetched = await fetchHtml(searchUrl, ctx, { allowStatuses: [404, 410] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to search user "${username}": ${message}`);
    }

    if (!fetched) {
      ctx.log(
        `[Poringa] Search returned empty/gone for "${username}" (HTTP 404/410)`,
      );
      break;
    }

    const pagePosts = extractPostUrls(fetched.html, username);
    let added = 0;
    for (const postUrl of pagePosts) {
      if (!found.has(postUrl)) {
        found.add(postUrl);
        added += 1;
      }
    }

    ctx.log(`[Poringa] Page ${page}: +${added} posts (${found.size} total)`);
    // gallery-dl stops around <19 unique ids per page
    if (pagePosts.length < 19 || added === 0) {
      break;
    }
  }

  return [...found];
}

function extractPostUrls(html, username) {
  const urls = [];
  const seen = new Set();
  const owner = (username || "").trim();
  const ownerRe = owner
    ? new RegExp(`/${escapeRegExp(owner)}/`, "i")
    : null;

  // Prefer full anchors so we keep the slug when present.
  for (const match of html.matchAll(
    /href=["']((?:https?:\/\/(?:www\.)?poringa\.net)?\/posts\/imagenes\/\d+(?:\/[^"'?\s#]+)?\.html)["']/gi,
  )) {
    const normalized = match[1].startsWith("http")
      ? match[1]
      : `https://www.poringa.net${match[1]}`;
    if (seen.has(normalized)) {
      continue;
    }
    // When possible, keep only posts that belong to this user (CDN path / thumbs).
    if (ownerRe) {
      const around = html.slice(
        Math.max(0, match.index - 280),
        Math.min(html.length, match.index + 280),
      );
      if (!ownerRe.test(around) && !ownerRe.test(normalized)) {
        continue;
      }
    }
    seen.add(normalized);
    urls.push(normalized);
  }

  // Fallback: bare post ids (gallery-dl style).
  if (urls.length === 0) {
    for (const match of html.matchAll(POST_ID_RE)) {
      const id = match[1];
      const normalized = `https://www.poringa.net/posts/imagenes/${id}`;
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      urls.push(normalized);
    }
  }

  return urls;
}

function parseTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "poringa.net") {
    return null;
  }

  const postMatch = parsed.pathname.match(POST_PATH_RE);
  if (postMatch) {
    const slug = (postMatch[3] || "").replace(/\.html$/i, "");
    return {
      kind: "post",
      category: postMatch[1],
      postId: postMatch[2],
      slug,
    };
  }

  const userMatch = parsed.pathname.match(USER_PATH_RE);
  if (userMatch) {
    const user = userMatch[1];
    if (!RESERVED_USER_PATHS.has(user.toLowerCase())) {
      return { kind: "user", user };
    }
  }

  return null;
}

function absolutePostUrl(target) {
  const slug = target.slug ? `/${target.slug}.html` : "";
  return `https://www.poringa.net/posts/${target.category}/${target.postId}${slug}`;
}

function extractTitle(html) {
  const ogTitle = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  if (ogTitle) {
    return decodeHtml(ogTitle[1].trim());
  }

  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleTag) {
    return decodeHtml(titleTag[1].replace(/\s*[-|]\s*Poringa.*$/i, "").trim());
  }

  return "";
}

function extractUsername(html) {
  const rss = html.match(/\/rss\/([A-Za-z0-9_.-]{2,40})\/temas\//i);
  if (rss && !RESERVED_USER_PATHS.has(rss[1].toLowerCase())) {
    return rss[1];
  }

  const fromImages = extractUsernameFromImages(html);
  if (fromImages) {
    return fromImages;
  }

  const hrefUsers = [
    ...html.matchAll(/href=["']\/([A-Za-z0-9_.-]{2,40})\/?["']/gi),
  ]
    .map((match) => match[1])
    .filter((user) => !RESERVED_USER_PATHS.has(user.toLowerCase()));

  return hrefUsers[0] || "";
}

function extractUsernameFromImages(html) {
  const match = html.match(
    /poringa\.(?:net|com)\/poringa\/(?:posts|img)\/(?:[0-9A-Fa-f]\/){1,8}([A-Za-z0-9_.-]{2,40})\//i,
  );
  return match ? match[1] : "";
}

function extractImages(html, username) {
  const images = [];
  const seen = new Set();
  const owner = (username || "").trim();

  const add = (raw) => {
    if (!raw) {
      return;
    }
    let src = raw.trim();
    if (src.startsWith("//")) {
      src = `https:${src}`;
    }
    if (!/^https?:\/\//i.test(src)) {
      return;
    }
    if (!/poringa\.net\//i.test(src)) {
      return;
    }
    if (
      /(?:avatar|thumb|icon|logo|flag|placeholder|emoji|smiley)/i.test(src)
    ) {
      return;
    }
    // Related-post widgets use size-prefixed thumbs like 195x147_ABC.jpg
    if (/\/\d{2,4}x\d{2,4}_[^/]+\.(?:jpe?g|png|gif|webp)$/i.test(src)) {
      return;
    }
    if (
      !/\.(?:jpe?g|png|gif|webp)(?:$|\?)/i.test(src) &&
      !/\/(?:original|full|posts|img)\//i.test(src)
    ) {
      return;
    }
    if (owner && !new RegExp(`/${escapeRegExp(owner)}/`, "i").test(src)) {
      return;
    }

    const key = src.split("?")[0];
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    images.push(key);
  };

  for (const match of html.matchAll(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi,
  )) {
    add(match[1]);
  }

  for (const match of html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    add(match[1]);
  }

  // Prefer full post CDN paths when both variants exist.
  return images.sort((a, b) => {
    const score = (value) =>
      (/\/poringa\/posts\//i.test(value) ? 2 : 0) +
      (/\/poringa\/img\//i.test(value) ? 1 : 0);
    return score(b) - score(a);
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} url
 * @param {{ signal: AbortSignal, cookies?: string, headers?: Record<string, string>, userAgent?: string }} ctx
 * @param {{ allowStatuses?: number[] }} [options]
 * @returns {Promise<{ html: string, finalUrl: string }|null>}
 */
async function fetchHtml(url, ctx, options = {}) {
  const allowStatuses = new Set(options.allowStatuses || []);
  const headers = {
    "User-Agent": ctx.userAgent || USER_AGENT,
    "Accept-Language": "es-AR,es;q=0.9",
    Accept: "text/html,application/xhtml+xml",
    ...(ctx.headers || {}),
  };
  if (ctx.cookies) {
    headers.Cookie = ctx.cookies;
  }

  const response = await fetch(url, {
    headers,
    signal: ctx.signal,
    redirect: "follow",
  });

  if (allowStatuses.has(response.status)) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  // Soft profile wall — caller may still parse, but user listing uses search.
  if (/\/registro-login\?/i.test(response.url) && /private=profile/i.test(response.url)) {
    throw new Error(
      ctx.cookies
        ? "Private Poringa profile: login required (cookies rejected or session expired — update Auth for poringa.net)"
        : "Private Poringa profile: login required — configure cookies for poringa.net in Auth, or use public search via the exact username",
    );
  }

  const html = await response.text();
  return { html, finalUrl: response.url };
}

function getExt(url) {
  const match = url.split("?")[0].match(/\.(\w{2,4})$/);
  return match ? match[1].toLowerCase() : "jpg";
}

function getStem(url) {
  const base = url.split("?")[0].split("/").pop() || "img";
  return base.replace(/\.[^.]+$/, "");
}

function sanitize(name) {
  return (name || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function capitalize(name) {
  const cleaned = (name || "Unknown").trim();
  if (!cleaned) {
    return "Unknown";
  }
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
