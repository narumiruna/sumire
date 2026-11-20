# Changesets

Add a changeset for changes that should ship in a Sumire release, including
changes to the admin app and shared packages. To create a changeset, run:

```bash
npm run changeset
```

Select only `@narumitw/sumire`, choose a SemVer bump for the product change,
and summarize what changed. Omit the changeset when no release is needed.

The [release workflow](../.github/workflows/publish.yml) maintains the release
pull request and tags the merged Sumire version. It does not publish to npm.
