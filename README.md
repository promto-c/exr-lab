# EXR Workspace

Monorepo for:

- `@blackboard/exr-reader`: reusable OpenEXR parser/decoder library.
- `@blackboard/exr-lab`: demo viewer app consuming the library.

## Quick Start

Prerequisites: Node.js 20+

1. Install dependencies: `npm install`
2. Run app in dev mode: `npm run dev`
3. Run full quality gates: `npm run lint && npm run typecheck && npm run test && npm run build`

## Packages

- Library: [`packages/exr-reader`](./packages/exr-reader)
- Demo app: [`apps/exr-lab`](./apps/exr-lab)
