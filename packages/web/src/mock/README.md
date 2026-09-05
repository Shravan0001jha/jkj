# mock/

Everything in this folder is fabricated. It exists so the UI can be designed,
reviewed and demoed before the server can do the work for real.

- `fixtures.ts` — the seed state: projects, agents, transcripts, MCP, context
- `simulator.ts` — a timer that advances scripted agents so the UI has motion

**Deleting this folder should be the whole migration.** When the server is
wired up, `App.tsx` seeds the store from `/api/*` and the socket instead of
`buildFixtures()`, and `startSimulator()` is dropped. No component imports
anything from here.
