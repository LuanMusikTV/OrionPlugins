# Ørion Plugins

Official plugin repository for Ørion Gallery Downloader.

Browse and install plugins from the **Plugins → Repositorio** tab in the app.

## Structure

```
apps/OrionPlugins/
├── index.json              # Catalog served via GitHub raw
└── plugins/
    └── <plugin-id>/
        ├── manifest.json
        ├── <plugin-id>.js
        └── README.md
```

## Adding a plugin

1. Create a folder under `plugins/<plugin-id>/`
2. Add `manifest.json`, the plugin `.js` file, and a `README.md`
3. Register the plugin in `index.json` with `downloadUrl` and `readmeUrl` pointing to this repo's raw URLs:

```
https://raw.githubusercontent.com/LuanMusikTV/Orion-Desktop/main/apps/OrionPlugins/...
```
