# Releasing

This package publishes from the `node/` directory using Changesets and GitHub Actions.

## One-time setup

Configure npm Trusted Publishing for `@cluic/codex-remote-proxy`:

- Repository: `cluic/codex-remote-proxy`
- Workflow file: `.github/workflows/release.yml`
- Environment: leave empty unless you intentionally scope publishing to a GitHub environment

Trusted Publishing is configured in npm package settings for the published package.

## Normal release flow

1. Make code changes.
2. Run `npm run changeset`.
3. Commit the generated file under `node/.changeset/`.
4. Merge the PR into `main`.
5. GitHub Actions opens or updates a release PR.
6. Merge the release PR.
7. GitHub Actions publishes the package to npm.

## Useful commands

```bash
cd node
npm run changeset
npm run version-packages
```

## Notes

- Publishing uses npm Trusted Publishing via GitHub OIDC, so no long-lived `NPM_TOKEN` is required.
- If a change should not release the npm package, do not add a changeset.
