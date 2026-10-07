# Foreman dashboard

Next.js (App Router) UI for Foreman. It talks only to the coordinator's public demo API (`/demo/*`) and WebSocket (`/demo/ws`), so it needs no sign-in and never sees worker IDs or host paths.

Pages: overview (`/`), jobs and job detail with events, logs, artifacts and cancel (`/jobs`), workers (`/workers`), and guided scenarios (`/playground`).

```bash
pnpm install
NEXT_PUBLIC_API_URL=http://localhost:8080 pnpm dev   # http://localhost:3000
pnpm lint
pnpm build
```

`NEXT_PUBLIC_API_URL` is baked in at build time. The Docker image takes it as a build argument; in production it is the relative path `/api`. See the [project README](../README.md) for the full stack.
