# Tensor.Art Plugin

Downloads images from [Tensor.Art](https://tensor.art).

## Supported URLs

- `https://tensor.art/images/{id}` — single image
- `https://tensor.art/u/{username}` — user profile gallery

## Notes

- Single images are resolved from page metadata (`og:image`).
- User galleries paginate through the public Tensor.Art API when available.
