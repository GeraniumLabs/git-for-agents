# Contributing to Loom

Thanks for helping. Loom is small enough to read in an afternoon: a Worker (`src/index.ts`), one Durable Object per project (`src/coordinator.ts`), and a dashboard in plain JavaScript (`public/`).

## Run it

```sh
npm install
npm run shim    # a local stand-in for Artifacts, git and checks, on :8790
npm run dev     # Loom on http://localhost:8787 (admin token: dev-admin)
```

Sign in locally as any GitHub login from the dashboard; no GitHub app is needed.

## Test it

```sh
npm run typecheck
npm test                                        # unit tests
LOOM_E2E_URL=http://127.0.0.1:8787 npm test     # plus end-to-end tests, with shim and dev running
```

The end-to-end tests drive a real local Loom with scripted agents. A change that touches how agents or people work should come with one.

## Make a change

- Open an issue first for anything large, so we can agree on the shape.
- Match the code around you: plain names, short comments that say why, no new dependencies without a reason.
- Keep user-facing text plain and specific. Say what happened and what to do next.
- One change per pull request, with a description of what it does and how you checked it.

Good first issues are labeled [`good first issue`](https://github.com/GeraniumLabs/git-for-agents/labels/good%20first%20issue).

## License

By contributing, you agree that your contributions are licensed under the MIT License.
