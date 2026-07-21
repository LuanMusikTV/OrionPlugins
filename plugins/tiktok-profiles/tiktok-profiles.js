// tiktok-profiles.js — Ørion Gallery Plugin
// Downloads all videos from a TikTok user profile.
// Single /video/ URLs are left to gallery-dl (built-in extractor).

const crypto = require("crypto");
const { spawn } = require("child_process");
const { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, statSync } = require("fs");
const { tmpdir, homedir } = require("os");
const { join, basename } = require("path");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SITE_FOLDER = "Tiktok";
const REHYDRATION_MARKER =
  '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">';
const RESERVED_SEGMENTS = new Set([
  "video",
  "photo",
  "live",
  "avatar",
  "reposts",
  "stories",
  "liked",
  "likes",
  "saved",
  "following",
  "music",
  "tag",
  "embed",
  "share",
]);

module.exports = {
  name: "TikTok Profiles",
  version: "1.0.6",
  description:
    "Downloads all videos from a TikTok user profile (single video URLs still use gallery-dl)",
  author: "LuanMusikTV",
  domains: ["tiktok.com", "www.tiktok.com"],
  homepage: "https://www.tiktok.com",

  canHandle(url) {
    return parseProfileTarget(url) !== null;
  },

  async probe(url, ctx) {
    const target = parseProfileTarget(url);
    if (!target) {
      throw new Error(`Unsupported TikTok profile URL: ${url}`);
    }

    const session = createSession(ctx);
    const profileUrl = buildProfileUrl(target.username);
    ctx.log(`[TikTok] Probing profile @${target.username}`);
    const userDetail = await loadUserDetail(profileUrl, target.username, session, ctx);
    const videoCount = extractVideoCount(userDetail);
    const uniqueId = userDetail?.userInfo?.user?.uniqueId || target.username;

    return {
      title: `@${uniqueId}`,
      artist: uniqueId,
      siteName: "TikTok",
      fileCount: videoCount > 0 ? videoCount : undefined,
    };
  },

  async getFiles(url, ctx) {
    const target = parseProfileTarget(url);
    if (!target) {
      throw new Error(`Unsupported TikTok profile URL: ${url}`);
    }

    const session = createSession(ctx);
    const profileUrl = buildProfileUrl(target.username);
    const userDetail = await loadUserDetail(profileUrl, target.username, session, ctx);
    const uniqueId = userDetail?.userInfo?.user?.uniqueId || target.username;
    const secUid = userDetail?.userInfo?.user?.secUid;

    ctx.log(`[TikTok] Listing posts for @${uniqueId}`);
    if (session.cookiesFilePath) {
      ctx.log(`[TikTok] Auth cookies file: ${basename(session.cookiesFilePath)}`);
    } else if (ctx.cookies) {
      ctx.log("[TikTok] Using Cookie header from Auth (no cookies file path found)");
    } else {
      ctx.log("[TikTok] WARNING: no Auth cookies loaded — resolution may fail");
    }

    const posts = await listProfilePosts(uniqueId, profileUrl, secUid, session, ctx);

    if (posts.length === 0) {
      throw new Error(
        `No posts found for @${uniqueId}. The profile may be empty, private, or blocked — refresh cookies and retry.`,
      );
    }

    ctx.log(`[TikTok] ${posts.length} post(s) found — downloading via gallery-dl`);
    const files = [];
    const userFolder = capitalize(uniqueId);
    const destDir = join(ctx.outputDir, SITE_FOLDER, userFolder);
    mkdirSync(destDir, { recursive: true });

    for (let index = 0; index < posts.length; index += 1) {
      if (ctx.signal.aborted) {
        throw new Error("Operation canceled");
      }

      if (index > 0) {
        await sleep(400);
      }

      const item = posts[index];
      const postUrl = buildPostPageUrl(item, uniqueId);

      try {
        let localPath = findDownloadedPostFile(destDir, item.id);
        if (localPath) {
          ctx.log(`[TikTok] ${item.id}: already on disk`);
        } else {
          await downloadPostWithGalleryDl(postUrl, destDir, item.id, session, ctx);
          localPath = findDownloadedPostFile(destDir, item.id);
        }

        if (!localPath) {
          throw new Error("gallery-dl finished but output file is missing");
        }

        const ext = localPath.includes(".")
          ? localPath.slice(localPath.lastIndexOf(".") + 1)
          : "mp4";
        const relativeName = `${SITE_FOLDER}/${userFolder}/${item.id}.${ext}`;

        files.push({
          url: postUrl,
          filename: relativeName,
          localPath,
          referer: postUrl,
        });
        ctx.log(`[TikTok] ${files.length} file(s) ready (${index + 1}/${posts.length})`);
        ctx.onProgress({
          completedFiles: files.length,
          totalFiles: posts.length,
          currentFile: relativeName,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log(`[TikTok] Skipping ${item.id}: ${message}`);
      }
    }

    if (files.length === 0) {
      throw new Error(
        `Could not download any media for @${uniqueId}. Check Auth cookies for tiktok.com and retry.`,
      );
    }

    return files;
  },
};

function createSession(ctx) {
  const cookiesFilePath = resolveAuthCookiesFilePath();
  return {
    cookies: createCookieState(ctx.cookies),
    cookiesFilePath,
  };
}

function resolveAuthCookiesFilePath() {
  try {
    const authPath = join(homedir(), ".orion", "gallery-downloader", "auth.json");
    if (!existsSync(authPath)) {
      return null;
    }
    const raw = JSON.parse(readFileSync(authPath, "utf8"));
    const configs = Array.isArray(raw?.configs) ? raw.configs : [];
    const match = configs.find((config) => {
      if (!config?.enabled || config.method !== "cookies-file") {
        return false;
      }
      const domain = String(config.siteDomain || "")
        .toLowerCase()
        .replace(/^www\./, "");
      return domain === "tiktok.com" || domain.endsWith(".tiktok.com");
    });
    if (!match?.cookiesFilePath || !existsSync(match.cookiesFilePath)) {
      return null;
    }
    return match.cookiesFilePath;
  } catch {
    return null;
  }
}

function parseProfileTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "tiktok.com") {
    return null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0 || segments[0][0] !== "@") {
    return null;
  }

  const username = segments[0].slice(1);
  if (!username || RESERVED_SEGMENTS.has(username.toLowerCase())) {
    return null;
  }

  if (segments.length === 1) {
    return { username };
  }

  if (segments.length === 2 && segments[1].toLowerCase() === "posts") {
    return { username };
  }

  return null;
}

function buildProfileUrl(username) {
  return `https://www.tiktok.com/@${username}`;
}

function buildPostsUrl(username) {
  return `https://www.tiktok.com/@${username}/posts`;
}

function buildPostPageUrl(item, fallbackUsername) {
  const user = item.author?.uniqueId || fallbackUsername;
  const kind = item.imagePost ? "photo" : "video";
  return `https://www.tiktok.com/@${user}/${kind}/${item.id}`;
}

async function loadUserDetail(profileUrl, username, session, ctx) {
  const html = await fetchPage(profileUrl, session, ctx);
  const data = extractRehydrationData(html);
  if (!data?.["webapp.user-detail"]) {
    throw new Error(
      `TikTok blocked the profile page for @${username}. Export fresh cookies while logged in.`,
    );
  }

  const detail = data["webapp.user-detail"];
  const status = detail.statusCode;
  if (status === 10221) {
    throw new Error(`User @${username} was not found on TikTok`);
  }
  if (status === 10222) {
    const count = extractVideoCount(detail);
    if (!count) {
      throw new Error(
        `Profile @${username} is private or requires login — configure cookies for tiktok.com in Auth`,
      );
    }
  }

  return detail;
}

function extractVideoCount(detail) {
  const stats = detail?.userInfo?.stats || detail?.userInfo?.statsV2;
  if (!stats) {
    return 0;
  }
  const raw = stats.videoCount;
  const parsed = Number.parseInt(String(raw ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function listProfilePosts(username, profileUrl, secUid, session, ctx) {
  const items = new Map();
  const owner = normalizeUsername(username);

  // Prefer the API when we have secUid — it returns that user's posts only.
  if (secUid) {
    ctx.log("[TikTok] Trying creator/item_list API");
    try {
      const apiItems = await listPostsFromApi(secUid, profileUrl, session, ctx);
      mergeOwnedItems(items, apiItems, owner);
      ctx.log(`[TikTok] ${items.size} post(s) from API`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(`[TikTok] API listing failed: ${message}`);
    }
  }

  if (items.size === 0) {
    const postsUrl = buildPostsUrl(username);
    ctx.log(`[TikTok] Reading embedded post list from ${postsUrl}`);
    try {
      const postsHtml = await fetchPage(postsUrl, session, ctx);
      mergeOwnedItems(items, extractItemsFromHtml(postsHtml, owner), owner);
      ctx.log(`[TikTok] ${items.size} post(s) from posts page`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(`[TikTok] Posts page parse failed: ${message}`);
    }
  }

  if (items.size === 0) {
    ctx.log("[TikTok] Falling back to profile page scrape");
    const profileHtml = await fetchPage(profileUrl, session, ctx);
    mergeOwnedItems(items, extractItemsFromHtml(profileHtml, owner), owner);
  }

  return [...items.values()];
}

async function listPostsFromApi(secUid, profileUrl, session, ctx) {
  const collected = new Map();
  let deviceId = randomDeviceId();
  let cursor = Date.now();
  let page = 0;
  const maxPages = 200;

  while (page < maxPages) {
    if (ctx.signal.aborted) {
      throw new Error("Operation canceled");
    }

    page += 1;
    const apiUrl = buildApiUrl(
      "creator/item_list",
      cursor,
      {
        secUid,
        type: "1",
        count: "15",
      },
      deviceId,
      session,
    );

    ctx.log(`[TikTok] API page ${page}`);
    const data = await fetchJson(apiUrl, session, ctx, { referer: profileUrl });
    if (data.statusCode && data.statusCode !== 0) {
      throw new Error(
        `TikTok API ${data.statusCode}: ${data.statusMsg || data.status_msg || "error"}`,
      );
    }
    const batch = Array.isArray(data.itemList) ? data.itemList : [];

    if (batch.length === 0) {
      if (data.hasMorePrevious === false || data.hasMore === false) {
        break;
      }
      if (page === 1) {
        break;
      }
    }

    const before = collected.size;
    mergeItems(collected, batch);

    if (collected.size === before && batch.length > 0) {
      deviceId = randomDeviceId();
      ctx.log("[TikTok] Duplicate API page — retrying with a new device id");
      page -= 1;
      continue;
    }

    const last = batch[batch.length - 1];
    const oldCursor = cursor;
    if (last?.createTime) {
      cursor = Number(last.createTime) * 1000;
    } else {
      cursor = 0;
    }
    if (!cursor || cursor === oldCursor) {
      cursor = oldCursor - 7 * 86_400_000;
    }

    const hasMore =
      data.hasMorePrevious !== false &&
      data.hasMore !== false &&
      cursor >= 1472706000000;
    if (!hasMore) {
      break;
    }
  }

  return [...collected.values()];
}

function extractItemsFromHtml(html, username) {
  const owner = normalizeUsername(username);
  const items = new Map();
  const data = extractRehydrationData(html);
  mergeOwnedItems(items, extractItemsFromRehydration(data), owner);

  // Only accept URLs that explicitly belong to this @user — never generic "id" fields
  // (TikTok embeds recommended/related video IDs in the same page).
  for (const id of extractOwnedVideoIdsFromHtml(html, owner)) {
    if (!items.has(id)) {
      items.set(id, { id, author: { uniqueId: owner } });
    }
  }

  return [...items.values()];
}

function extractItemsFromRehydration(data) {
  if (!data) {
    return [];
  }

  const userDetail = data["webapp.user-detail"];
  if (!userDetail) {
    return [];
  }

  const direct = userDetail.itemList;
  if (Array.isArray(direct) && direct.length > 0) {
    return direct;
  }

  // Prefer lists nested under userInfo / user-detail only (not global recommendations).
  return findItemListUnderUserDetail(userDetail);
}

function findItemListUnderUserDetail(userDetail) {
  const candidates = [
    userDetail?.userInfo?.itemList,
    userDetail?.itemList,
    userDetail?.items,
  ];

  for (const list of candidates) {
    if (Array.isArray(list) && list.length > 0 && list[0]?.id) {
      return list;
    }
  }

  return [];
}

function extractOwnedVideoIdsFromHtml(html, username) {
  const ids = new Set();
  const escaped = escapeRegExp(username);
  // Only accept explicit profile media links. Broader JSON "id" matching
  // pulls deleted/recommended posts that gallery-dl then rejects.
  const pattern = new RegExp(`@${escaped}/(?:video|photo)/(\\d+)`, "gi");
  for (const match of html.matchAll(pattern)) {
    if (match[1]) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

function normalizeUsername(username) {
  return String(username || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function itemBelongsToUser(item, owner) {
  if (!item?.id) {
    return false;
  }

  const author =
    item.author?.uniqueId ||
    item.author?.unique_id ||
    item.nickname ||
    item.uniqueId;
  if (!author) {
    // ID-only stubs created from @user/video/ links are trusted.
    return true;
  }

  return normalizeUsername(author) === owner;
}

function mergeOwnedItems(target, items, owner) {
  const normalizedOwner = normalizeUsername(owner);
  for (const item of items) {
    if (!itemBelongsToUser(item, normalizedOwner)) {
      continue;
    }
    target.set(String(item.id), item);
  }
}

function mergeItems(target, items) {
  for (const item of items) {
    if (!item?.id) {
      continue;
    }
    target.set(String(item.id), item);
  }
}

async function resolvePostFiles(item, postUrl, userFolder, session, ctx, expectedOwner) {
  const owner = normalizeUsername(expectedOwner || userFolder);
  const errors = [];

  // 1) Media already present on list items (rare, but free).
  try {
    if (itemBelongsToUser(item, owner)) {
      const direct = buildFilesFromItemStruct(item, userFolder, postUrl, ctx);
      if (direct.length > 0) {
        ctx.log(`[TikTok] ${item.id}: media from list payload`);
        return direct;
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  // 2) Primary path: gallery-dl --get-urls with the Auth Netscape cookies file.
  //    Single TikTok videos already work this way in Ørion.
  try {
    const urls = await resolveUrlsWithGalleryDl(postUrl, session, ctx);
    if (urls.length > 0) {
      ctx.log(`[TikTok] ${item.id}: resolved ${urls.length} URL(s) via gallery-dl`);
      return urls.map((url, index) => {
        const ext = guessExtension(url);
        const suffix = urls.length > 1 ? `_${String(index + 1).padStart(2, "0")}` : "";
        return {
          url,
          filename: `${SITE_FOLDER}/${userFolder}/${item.id}${suffix}.${ext}`,
          referer: postUrl,
          headers: buildFileHeaders(ctx, postUrl),
        };
      });
    }
    errors.push("gallery-dl returned no URLs");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  // 3) Last resort: post page rehydration.
  try {
    const html = await fetchPage(postUrl, session, ctx);
    const data = extractRehydrationData(html);
    const post = data?.["webapp.video-detail"]?.itemInfo?.itemStruct;
    if (post) {
      if (!itemBelongsToUser(post, owner)) {
        throw new Error(
          `Post ${post.id} is by @${post.author?.uniqueId || "unknown"}, not @${owner}`,
        );
      }
      const fromPage = buildFilesFromItemStruct(post, userFolder, postUrl, ctx);
      if (fromPage.length > 0) {
        return fromPage;
      }
      throw new Error("Post page had no downloadable media URLs");
    }
    throw new Error("Could not read post metadata from page");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  throw new Error(errors.filter(Boolean).join(" | ") || "No media URL");
}

function buildFilesFromItemStruct(post, userFolder, referer, ctx) {
  if (!post?.id) {
    return [];
  }

  const files = [];

  if (post.imagePost?.images?.length) {
    post.imagePost.images.forEach((image, index) => {
      const url =
        image?.imageURL?.urlList?.[0] ||
        image?.imageUrl?.urlList?.[0] ||
        image?.urlList?.[0];
      if (!url) {
        return;
      }
      const num = String(index + 1).padStart(2, "0");
      files.push({
        url,
        filename: `${SITE_FOLDER}/${userFolder}/${post.id}_${num}.jpg`,
        referer,
        headers: buildFileHeaders(ctx, referer),
      });
    });
    if (files.length > 0) {
      return files;
    }
  }

  const videoUrl = extractVideoDownloadUrl(post.video || post);
  if (!videoUrl) {
    return files;
  }

  files.push({
    url: videoUrl,
    filename: `${SITE_FOLDER}/${userFolder}/${post.id}.mp4`,
    referer,
    headers: buildFileHeaders(ctx, referer),
  });
  return files;
}

function extractVideoDownloadUrl(video) {
  if (!video || typeof video !== "object") {
    return null;
  }

  const candidates = [];

  const bitrateInfo = video.bitrateInfo || video.BitrateInfo;
  if (bitrateInfo) {
    const entries = Array.isArray(bitrateInfo) ? bitrateInfo : [bitrateInfo];
    for (const info of entries) {
      const playAddr = info.PlayAddr || info.playAddr;
      const urlList = playAddr?.UrlList || playAddr?.urlList || [];
      const width = Number(playAddr?.Width || playAddr?.width || 0);
      const height = Number(playAddr?.Height || playAddr?.height || 0);
      for (const url of urlList) {
        if (typeof url === "string" && /^https?:\/\//i.test(url)) {
          candidates.push({ url, score: width * height });
        }
      }
    }
  }

  for (const key of [
    "playAddr",
    "downloadAddr",
    "play_addr",
    "download_addr",
  ]) {
    const value = video[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      candidates.push({ url: value, score: 1 });
    } else if (value && typeof value === "object") {
      const urlList = value.UrlList || value.urlList || [];
      for (const url of urlList) {
        if (typeof url === "string" && /^https?:\/\//i.test(url)) {
          candidates.push({ url, score: 1 });
        }
      }
    }
  }

  const playAddrStruct = video.playAddrStruct || video.PlayAddrStruct;
  if (playAddrStruct) {
    const urlList = playAddrStruct.UrlList || playAddrStruct.urlList || [];
    for (const url of urlList) {
      if (typeof url === "string" && /^https?:\/\//i.test(url)) {
        candidates.push({ url, score: 1 });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url;
}

function resolveGalleryDlBinary() {
  const homeBin = join(
    homedir(),
    ".orion",
    "gallery-downloader",
    "bin",
    process.platform === "win32" ? "gallery-dl-win.exe" : "gallery-dl-linux",
  );
  if (existsSync(homeBin)) {
    return homeBin;
  }
  return null;
}

function findDownloadedPostFile(destDir, postId) {
  const extensions = ["mp4", "webm", "jpg", "jpeg", "webp", "png", "mp3"];
  for (const ext of extensions) {
    const candidate = join(destDir, `${postId}.${ext}`);
    if (existsSync(candidate) && statSync(candidate).size > 0) {
      return candidate;
    }
  }
  return null;
}

async function downloadPostWithGalleryDl(postUrl, destDir, postId, session, ctx) {
  const binary = resolveGalleryDlBinary();
  if (!binary) {
    throw new Error("gallery-dl binary not found under ~/.orion");
  }

  let cookiesPath = session.cookiesFilePath;
  let tempDir = null;
  if (!cookiesPath || !existsSync(cookiesPath)) {
    if (!session.cookies.map.size) {
      throw new Error("No Auth cookies file for gallery-dl");
    }
    tempDir = mkdtempSync(join(tmpdir(), "orion-tiktok-"));
    cookiesPath = join(tempDir, "cookies.txt");
    writeFileSync(cookiesPath, toNetscapeCookies(session.cookies.map), "utf8");
  }

  try {
    ctx.log(`[TikTok] gallery-dl download ${postId}`);
    const { stderr, code } = await runProcess(
      binary,
      [
        "--cookies",
        cookiesPath,
        "-d",
        destDir,
        "-o",
        "filename={id}.{extension}",
        "-o",
        "directory=",
        postUrl,
      ],
      ctx.signal,
    );

    const outputPath = findDownloadedPostFile(destDir, postId);
    if (outputPath) {
      return;
    }

    const hint = (stderr || "").trim().split(/\r?\n/).slice(-4).join(" ");
    throw new Error(
      `gallery-dl exit ${code}${hint ? `: ${hint.slice(0, 220)}` : ""}`,
    );
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

async function resolveUrlsWithGalleryDl(postUrl, session, ctx) {
  const binary = resolveGalleryDlBinary();
  if (!binary) {
    throw new Error("gallery-dl binary not found under ~/.orion");
  }

  let cookiesPath = session.cookiesFilePath;
  let tempDir = null;

  if (!cookiesPath || !existsSync(cookiesPath)) {
    if (!session.cookies.map.size) {
      throw new Error("No Auth cookies file and no Cookie header for gallery-dl");
    }
    tempDir = mkdtempSync(join(tmpdir(), "orion-tiktok-"));
    cookiesPath = join(tempDir, "cookies.txt");
    writeFileSync(cookiesPath, toNetscapeCookies(session.cookies.map), "utf8");
  }

  try {
    ctx.log(`[TikTok] gallery-dl --get-urls ${postUrl}`);
    const { stdout, stderr, code } = await runProcess(
      binary,
      ["--get-urls", "--cookies", cookiesPath, postUrl],
      ctx.signal,
    );

    const urls = parseGalleryDlUrlOutput(stdout);
    if (urls.length === 0) {
      const hint = (stderr || "").trim().split(/\r?\n/).slice(-4).join(" ");
      throw new Error(
        `gallery-dl exit ${code}${hint ? `: ${hint.slice(0, 220)}` : " (empty stdout)"}`,
      );
    }

    return urls;
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

/**
 * gallery-dl prints the primary URL first, then fallback mirrors as "| https://...".
 * Keep primary lines only so we don't download the same video 3–4 times.
 */
function parseGalleryDlUrlOutput(stdout) {
  const urls = [];
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("|")) {
      continue;
    }
    if (/^https?:\/\//i.test(line)) {
      urls.push(line);
    }
  }
  return urls;
}

function toNetscapeCookies(cookieMap) {
  const lines = ["# Netscape HTTP Cookie File"];
  for (const [name, value] of cookieMap.entries()) {
    lines.push(`.tiktok.com\tTRUE\t/\tFALSE\t0\t${name}\t${value}`);
  }
  return `${lines.join("\n")}\n`;
}

function runProcess(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const onAbort = () => {
      child.kill();
      reject(new Error("Operation canceled"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

function guessExtension(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/);
    if (match) {
      return match[1];
    }
  } catch {
    // ignore
  }
  if (/\.jpe?g/i.test(url)) {
    return "jpg";
  }
  if (/\.webp/i.test(url)) {
    return "webp";
  }
  return "mp4";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRehydrationData(html) {
  const start = html.indexOf(REHYDRATION_MARKER);
  if (start === -1) {
    return null;
  }
  const jsonStart = start + REHYDRATION_MARKER.length;
  const jsonEnd = html.indexOf("</script>", jsonStart);
  if (jsonEnd === -1) {
    return null;
  }
  try {
    const parsed = JSON.parse(html.slice(jsonStart, jsonEnd));
    return parsed.__DEFAULT_SCOPE__ || parsed;
  } catch {
    return null;
  }
}

function isWafChallengePage(html) {
  return html.includes('id="cs"') && html.includes("Please wait");
}

function solveWafChallenge(html) {
  const csMatch = html.match(/id="cs"[^>]*class="([^"]+)"/i);
  if (!csMatch?.[1]) {
    throw new Error("WAF challenge payload missing");
  }

  const decoded = JSON.parse(
    Buffer.from(`${csMatch[1]}==`, "base64").toString("utf8"),
  );
  const expected = Buffer.from(`${decoded.v.c}==`, "base64");
  const baseInput = Buffer.from(`${decoded.v.a}==`, "base64");

  let matchIndex = null;
  for (let index = 0; index < 1_000_000; index += 1) {
    const digest = crypto.createHash("sha256");
    digest.update(baseInput);
    digest.update(String(index));
    if (digest.digest().equals(expected)) {
      matchIndex = index;
      break;
    }
  }

  if (matchIndex === null) {
    throw new Error("Failed to solve TikTok WAF challenge");
  }

  const wci = extractClassValue(html, "wci");
  const rci = extractClassValue(html, "rci");
  const rs = extractClassValue(html, "rs");
  if (!wci) {
    throw new Error("WAF challenge cookie name missing");
  }

  decoded.d = Buffer.from(String(matchIndex), "utf8").toString("base64");
  const challengeValue = Buffer.from(JSON.stringify(decoded), "utf8").toString(
    "base64",
  );

  const cookies = { [wci]: challengeValue };
  if (rs && rci) {
    cookies[rci] = rs;
  }
  return cookies;
}

function extractClassValue(html, elementId) {
  const match = html.match(
    new RegExp(`id="${elementId}"[^>]*class="([^"]*)"`, "i"),
  );
  return match ? match[1] : "";
}

async function fetchPage(url, session, ctx) {
  let lastError = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (ctx.signal.aborted) {
      throw new Error("Operation canceled");
    }

    const response = await fetch(url, {
      headers: buildPageHeaders(ctx, session.cookies.header, url),
      signal: ctx.signal,
      redirect: "follow",
    });

    const html = await response.text();
    if (!response.ok && !isWafChallengePage(html)) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    if (isWafChallengePage(html)) {
      ctx.log("[TikTok] Solving WAF challenge");
      const solved = solveWafChallenge(html);
      mergeCookies(session.cookies, solved);
      continue;
    }

    if (extractRehydrationData(html) || /\/@(?:[^/"'?#]+)\/(?:video|photo)\/\d+/i.test(html)) {
      return html;
    }

    lastError = new Error(`No profile data in response for ${url}`);
  }

  throw lastError ?? new Error(`Failed to load ${url}`);
}

async function fetchJson(url, session, ctx, options = {}) {
  const response = await fetch(url, {
    headers: buildApiHeaders(ctx, session.cookies.header, options.referer),
    signal: ctx.signal,
  });

  if (!response.ok) {
    const body = await response.text();
    const snippet = body.trim().slice(0, 160);
    throw new Error(
      `HTTP ${response.status} for TikTok API${snippet ? `: ${snippet}` : ""}`,
    );
  }

  return response.json();
}

function buildApiUrl(endpoint, cursor, extraParams, deviceId, session) {
  const params = {
    aid: "1988",
    app_language: "en",
    app_name: "tiktok_web",
    browser_language: "en-US",
    browser_name: "Mozilla",
    browser_online: "true",
    browser_platform: "Win32",
    browser_version: "5.0 (Windows)",
    channel: "tiktok_web",
    cookie_enabled: "true",
    device_id: deviceId,
    device_platform: "web_pc",
    focus_state: "true",
    from_page: "user",
    history_len: "2",
    is_fullscreen: "false",
    is_page_visible: "true",
    language: "en",
    os: "windows",
    priority_region: "",
    referer: "",
    region: "US",
    screen_height: "1080",
    screen_width: "1920",
    tz_name: "UTC",
    verifyFp: `verify_${randomHex(7)}`,
    webcast_language: "en",
    cursor: String(Math.trunc(cursor)),
    ...extraParams,
  };

  const msToken = session.cookies.map.get("msToken");
  if (msToken) {
    params.msToken = msToken;
  }

  const query = new URLSearchParams(params).toString();
  return `https://www.tiktok.com/api/${endpoint}/?${query}`;
}

function buildPageHeaders(ctx, cookieHeader, referer) {
  const headers = {
    "User-Agent": ctx.userAgent || USER_AGENT,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    ...(ctx.headers || {}),
  };
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }
  if (referer) {
    headers.Referer = referer;
  }
  return headers;
}

function buildApiHeaders(ctx, cookieHeader, referer) {
  const headers = {
    "User-Agent": ctx.userAgent || USER_AGENT,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    ...(ctx.headers || {}),
  };
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }
  if (referer) {
    headers.Referer = referer;
  }
  return headers;
}

function buildFileHeaders(ctx, referer) {
  return {
    "User-Agent": ctx.userAgent || USER_AGENT,
    ...(referer ? { Referer: referer } : {}),
  };
}

function createCookieState(initialHeader) {
  return { map: parseCookieHeader(initialHeader), header: initialHeader || "" };
}

function parseCookieHeader(header) {
  const map = new Map();
  if (!header) {
    return map;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index > 0) {
      map.set(trimmed.slice(0, index), trimmed.slice(index + 1));
    }
  }
  return map;
}

function mergeCookies(state, additions) {
  for (const [name, value] of Object.entries(additions)) {
    state.map.set(name, value);
  }
  state.header = [...state.map.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function randomDeviceId() {
  let digits = "725";
  for (let index = 0; index < 16; index += 1) {
    digits += String(Math.floor(Math.random() * 10));
  }
  return digits;
}

function randomHex(length) {
  return crypto.randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

function capitalize(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "Unknown";
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
