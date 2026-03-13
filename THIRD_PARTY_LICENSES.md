# Third-Party Licenses

This repository includes the third-party runtime dependencies listed below.
Versions are resolved from `package-lock.json`.

## Third-Party Runtime Dependencies

| Package | Version | License | Repository | License File |
| --- | --- | --- | --- | --- |
| `@types/trusted-types` | `2.0.7` | `MIT` | <https://github.com/DefinitelyTyped/DefinitelyTyped.git> | `node_modules/@types/trusted-types/LICENSE` |
| `fflate` | `0.8.2` | `MIT` | <https://github.com/101arrowz/fflate> | `node_modules/fflate/LICENSE` |
| `lucide-react` | `0.563.0` | `ISC` | <https://github.com/lucide-icons/lucide.git> | `node_modules/lucide-react/LICENSE` |
| `react` | `19.2.4` | `MIT` | <https://github.com/facebook/react.git> | `node_modules/react/LICENSE` |
| `react-dom` | `19.2.4` | `MIT` | <https://github.com/facebook/react.git> | `node_modules/react-dom/LICENSE` |
| `scheduler` | `0.27.0` | `MIT` | <https://github.com/facebook/react.git> | `node_modules/scheduler/LICENSE` |
| `workbox-core` | `7.4.0` | `MIT` | <https://github.com/googlechrome/workbox.git> | `node_modules/workbox-core/LICENSE` |
| `workbox-window` | `7.4.0` | `MIT` | <https://github.com/googlechrome/workbox.git> | `node_modules/workbox-window/LICENSE` |

## Package Scope

- `packages/exr` depends on: `fflate`.
- `apps/exr-lab` depends on: `@bb-studio/exr` (local workspace package), `lucide-react`, `react`, `react-dom`, `workbox-window`.
