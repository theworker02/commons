# Root public surface

The canonical browser static assets are maintained in [`frontend/public`](../frontend/public) because the Vite application uses `frontend/` as its project root. This root directory is retained for static-hosting tools that discover a `public/` folder at the repository root.

Asset files should be sourced from `frontend/public/assets`; do not replace them with placeholders.
