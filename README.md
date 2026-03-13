# EXR Workspace

[![npm version](https://img.shields.io/npm/v/%40bb-studio%2Fexr?logo=npm)](https://www.npmjs.com/package/@bb-studio/exr)
[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Live%20Demo-0?logo=github)](https://promto-c.github.io/exr-lab/)
[![GitHub](https://img.shields.io/github/stars/promto-c/exr-lab)](https://github.com/promto-c/exr-lab)

Monorepo for:

- `@bb-studio/exr`: reusable OpenEXR parser/decoder library.
- `@bb-studio/exr-lab`: demo viewer app consuming the library.

## Quick Start

Prerequisites: Node.js 20+

1. Install dependencies: `npm install`
2. Run app in dev mode: `npm run dev`
3. Run full quality gates: `npm run lint && npm run typecheck && npm run test && npm run build`

## Packages

- Library: [`packages/exr`](./packages/exr)
- Demo app: [`apps/exr-lab`](./apps/exr-lab) | [Live Demo](https://promto-c.github.io/exr-lab/)

## Versioning and Releases

Changesets manages versions for both workspace packages:

- `@bb-studio/exr`: public npm package
- `@bb-studio/exr-lab`: private app package, versioned for app releases and deployments

Use the standard Changesets flow:

1. Create a changeset with `npm run changeset`
2. Select the affected package or packages:
   - `@bb-studio/exr` for library-only changes
   - `@bb-studio/exr-lab` for app-only changes
   - both packages when a change affects the public library and the shipped app
3. Merge the generated release PR from the `Release` workflow

The release workflow versions both packages when selected in a changeset, but only publishes `@bb-studio/exr` to npm because `@bb-studio/exr-lab` is private.

## Licensing

- Workspace license: [`LICENSE`](./LICENSE)
- Third-party runtime dependency notices: [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md)
