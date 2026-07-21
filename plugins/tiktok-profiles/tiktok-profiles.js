// tiktok-profiles.js — Ørion Gallery Plugin
// Downloads all videos from a TikTok user profile.
// Single /video/ URLs are left to gallery-dl (built-in extractor).

const crypto = require("crypto");

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
  version: "1.0.2",
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
    const posts = await listProfilePosts(uniqueId, profileUrl, secUid, session, ctx);

    if (posts.length === 0) {
      throw new Error(
        `No posts found for @${uniqueId}. The profile may be empty, private, or blocked — refresh cookies and retry.`,
      );
    }

    ctx.log(`[TikTok] ${posts.length} post(s) found — resolving download URLs`);
    const files = [];
    const userFolder = capitalize(uniqueId);

    for (let index = 0; index < posts.length; index += 1) {
      if (ctx.signal.aborted) {
        throw new Error("Operation canceled");
      }

      const item = posts[index];
      const postUrl = buildPostPageUrl(item, uniqueId);
      try {
        const resolved = await resolvePostFiles(
          item,
          postUrl,
          userFolder,
          session,
          ctx,
          uniqueId,
        );
        files.push(...resolved);
        ctx.log(
          `[TikTok] ${files.length} file(s) ready (${index + 1}/${posts.length})`,
        );
        ctx.onProgress({
          completedFiles: 0,
          totalFiles: files.length,
          currentFile: postUrl,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log(`[TikTok] Skipping ${item.id}: ${message}`);
      }
    }

    if (files.length === 0) {
      throw new Error(
        `Could not resolve any media for @${uniqueId}. TikTok may be blocking requests — export fresh cookies and retry.`,
      );
    }

    return files;
  },
};

function createSession(ctx) {
  return { cookies: createCookieState(ctx.cookies) };
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
        count: "35",
      },
      deviceId,
      session,
    );

    ctx.log(`[TikTok] API page ${page}`);
    const data = await fetchJson(apiUrl, session, ctx, { referer: profileUrl });
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
  // Require the username in the path so recommended reels are ignored.
  const patterns = [
    new RegExp(`@${escaped}/(?:video|photo)/(\\d+)`, "gi"),
    new RegExp(
      `"uniqueId"\\s*:\\s*"${escaped}"[\\s\\S]{0,400}?"id"\\s*:\\s*"(\\d{10,25})"`,
      "gi",
    ),
    new RegExp(
      `"id"\\s*:\\s*"(\\d{10,25})"\\s*,[\\s\\S]{0,400}?"uniqueId"\\s*:\\s*"${escaped}"`,
      "gi",
    ),
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      if (match[1]) {
        ids.add(match[1]);
      }
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

  if (item.video || item.imagePost) {
    if (!itemBelongsToUser(item, owner)) {
      throw new Error(`Post ${item.id} belongs to another user`);
    }
    const direct = buildFilesFromItemStruct(item, userFolder, postUrl, ctx);
    if (direct.length > 0) {
      return direct;
    }
  }

  const html = await fetchPage(postUrl, session, ctx);
  const data = extractRehydrationData(html);
  const post = data?.["webapp.video-detail"]?.itemInfo?.itemStruct;

  if (!post) {
    throw new Error("Could not read post metadata");
  }

  if (!itemBelongsToUser(post, owner)) {
    throw new Error(
      `Post ${post.id} is by @${post.author?.uniqueId || "unknown"}, not @${owner}`,
    );
  }

  return buildFilesFromItemStruct(post, userFolder, postUrl, ctx);
}

function buildFilesFromItemStruct(post, userFolder, referer, ctx) {
  const files = [];

  if (post.imagePost?.images?.length) {
    post.imagePost.images.forEach((image, index) => {
      const url = image?.imageURL?.urlList?.[0];
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
    return files;
  }

  const videoUrl = extractVideoDownloadUrl(post.video);
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
  if (!video) {
    return null;
  }

  const bitrateInfo = video.bitrateInfo;
  if (bitrateInfo) {
    const entries = Array.isArray(bitrateInfo) ? bitrateInfo : [bitrateInfo];
    let bestUrl = null;
    let bestSize = 0;
    for (const info of entries) {
      const playAddr = info.PlayAddr || info.playAddr;
      const urlList = playAddr?.UrlList || playAddr?.urlList || [];
      const width = Number(playAddr?.Width || playAddr?.width || 0);
      const height = Number(playAddr?.Height || playAddr?.height || 0);
      const size = width * height;
      const candidate = urlList[0];
      if (candidate && size >= bestSize) {
        bestSize = size;
        bestUrl = candidate;
      }
    }
    if (bestUrl) {
      return bestUrl;
    }
  }

  return video.playAddr || video.downloadAddr || null;
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
