## Getting Started

1) Install deps if you haven't yet:
```bash
npm install
npm install --prefix server
```

2) Ensure the frontend points at the local Express server (ports can be changed if needed):
```
SERVER_URL=http://localhost:4000
NEXT_PUBLIC_PIPELINE_URL=http://localhost:4000
```
These defaults live in `.env`, so `npm run dev:all` will already use them.

3) Run both the Next.js app (port 3000) and the Express server (port 4000) together:
```bash
npm run dev:all
```
The Next.js dev server rewrites `/api/*` to the Express backend, so the UI talks to the locally started server automatically.

### Useful commands
- `npm run dev:app` — start only the Next.js app
- `npm run dev:server` — start only the Express server in `server/`
- `npm run dev:all` — start both servers concurrently for local development
