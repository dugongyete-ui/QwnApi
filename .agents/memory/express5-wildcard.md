---
name: Express 5 wildcard route
description: Express 5 + path-to-regexp v8 rejects bare `*` catch-all; must use `*splat`
---

Express 5 upgraded path-to-regexp to v8.x which requires named parameters in wildcard routes.

**Rule:** Replace `app.get("*", ...)` with `app.get("*splat", ...)` for SPA catch-all fallback routes.

**Why:** path-to-regexp v8 throws `PathError: Missing parameter name at index 1: *` at startup if a bare `*` wildcard is registered, crashing the server before it can serve a single request.

**How to apply:** Any time a new catch-all / SPA fallback route is added to the Express app, always use `"*splat"` not `"*"`.
