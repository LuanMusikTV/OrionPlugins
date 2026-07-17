# Poringa Plugin

Downloads images from individual [Poringa.net](https://www.poringa.net) posts.

## Supported URLs

- `https://www.poringa.net/posts/{category}/{id}/{slug}/`

## Usage

1. Install from **Plugins → Repositorio**
2. Add a post URL to the queue
3. Images are scraped from the post HTML (`og:image` + content `<img>` tags)
