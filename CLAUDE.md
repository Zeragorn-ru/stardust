# Stardust Claude Code Instructions

## Working directory

- Run repository commands from `/opt/stardust`, not from a package subdirectory.
- Do not revert unrelated existing changes; inspect `git status --short` before editing.
- Keep generated output, archives, secrets, `dist/`, and build artifacts out of commits.

## Admin web

- Source lives in `admin-web/`; it has separate desktop and mobile entrypoints.
- Desktop dashboard: `admin-web/src/views/OverviewView.tsx` and the desktop sections of `admin-web/src/styles.css`.
- Mobile build/file editing: `admin-web/src/mobile/MobileBuildDetail.tsx`, `admin-web/src/FileManager.tsx`, `admin-web/src/FileEditor.tsx`, and `admin-web/src/mobile/mobile.css`.
- Reuse existing API, feedback, dialog, icon, and design-token patterns. Avoid changing backend contracts for visual work.
- Validate admin-web changes with:
  - `make build-admin-web` from the repository root, or
  - `cd admin-web && npm ci --ignore-scripts && npm run build` when dependencies are not installed.
- GitHub Actions `ci.yml` runs the same admin-web build on push/PR; its job uses Node 20, `npm ci --ignore-scripts`, then `npm run build` with `working-directory: admin-web`.
- `backend.yml` also rebuilds and publishes the admin-web Docker image on master pushes when `admin-web/**` changes, then deploys it automatically. Do not trigger a release tag for ordinary admin-web UI changes.

## CI/CD map

- `.github/workflows/ci.yml`: fast checks for push/PR; manual `target` supports `admin-web`.
- `.github/workflows/backend.yml`: backend tests, Docker image publishing, and master deployment; admin-web changes are included by path filter.
- Launcher releases use `vX.Y.Z` tags; mod releases use `mod-vX.Y.Z`. Do not create tags unless explicitly requested.
- Before committing, run the relevant package build, `git diff --check`, and review `git status --short`.

## Commit workflow

- Commit only files belonging to the current task.
- Use a short conventional commit message, e.g. `fix: improve admin mobile editor`.
- Do not push directly unless explicitly asked; the repository guide prefers the `fork` remote and a PR to upstream.
