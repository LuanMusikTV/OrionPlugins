# Poringa Plugin

Downloads images from [Poringa.net](https://www.poringa.net) posts and complete user profiles.

## Supported URLs

- Post: `https://www.poringa.net/posts/{category}/{id}/{slug}.html`
- User: `https://www.poringa.net/{username}`
- User posts: `https://www.poringa.net/{username}/posts`

Many profiles redirect to login (`private=profile`). The plugin lists posts through Poringa's public search (`/buscar/?q={username}`), same approach as gallery-dl.

**Username must match exactly.** Example: `Putifamosas` works; `Putifamosa` returns “user not found”.

## Folder structure

```
Poringa\
  Usuario\
    1234567_nombre del post_001_CA3.jpg
    1234567_nombre del post_002_1A2.jpg
```

## Usage

1. Install or update from **Plugins → Repositorio** (v1.2.1+)
2. Add a post URL or a user profile URL to the queue
3. Images are scraped from each post (`og:image` + content `<img>` tags)

When installed and enabled, Ørion routes Poringa URLs to this plugin instead of gallery-dl's built-in extractor (which nests an extra post-id folder and does not accept `/username/posts`).
