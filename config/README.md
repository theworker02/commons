# COMMONS configuration

The active Node runtime configuration is maintained in [`backend/config`](../backend/config). This root-facing configuration surface preserves the expected repository layout and provides release metadata for tools that discover project configuration from the root.

Use `backend/config/release.json` as the authoritative release source and `backend/packages/config/env.js` for runtime environment validation.
