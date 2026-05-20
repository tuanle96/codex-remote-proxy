# Changesets

This package uses Changesets for versioning and npm releases.

Typical flow:

1. Add your code changes.
2. Run `npm run changeset`.
3. Choose the release type.
4. Commit the generated markdown file under `.changeset/`.

After merge to `main`, GitHub Actions will open or update a release PR. Merging that PR will publish the package from `node/` to npm.
