# TikTok Profiles Plugin

Downloads every video (and photo carousel) from a TikTok **user profile**. Single post URLs (`/video/…`, `/photo/…`) are **not** handled by this plugin — Ørion keeps using gallery-dl for those, which already works well.

## Supported URLs

- `https://www.tiktok.com/@username`
- `https://www.tiktok.com/@username/`
- `https://www.tiktok.com/@username/posts`

## Not handled (gallery-dl)

- `https://www.tiktok.com/@username/video/1234567890`
- `https://www.tiktok.com/@username/photo/1234567890`
- Short links (`vm.tiktok.com`, etc.)

## Authentication

TikTok often blocks profile listing without a logged-in session.

1. Log in to TikTok in your browser (not guest mode).
2. Export cookies as Netscape `.txt` (e.g. “Get cookies.txt LOCALLY”).
3. In Ørion: **Autenticación** → domain `tiktok.com` → **Archivo cookies** → import → **Guardar**.
4. Add the profile URL to the queue.

Browser cookie import is **not** passed to plugins — use a cookies file.

## How it works

1. Loads the profile page (solves TikTok’s WAF challenge when needed).
2. Reads `secUid` from embedded page data.
3. Paginates `creator/item_list` to enumerate posts.
4. Resolves each post’s download URL the same way gallery-dl does for single videos.

## Folder structure

```
Tiktok\
  Username\
    7664579290872302869.mp4
    7123456789012345678.mp4
```

## Install

1. **Plugins → Repositorio** → install **TikTok Profiles**
2. Enable the plugin
3. Queue a profile URL (`@user`, not `/video/…`)

When enabled, profile URLs route to this plugin instead of gallery-dl’s profile extractor (which often returns HTTP 403).
