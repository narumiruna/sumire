# Changesets

Add a changeset for package changes. Do not add empty changesets when no package version should change.

Create a package changeset with:

```bash
npm run changeset
```

Select every affected package, including private packages that will not be published, choose the appropriate SemVer bump, and include a meaningful change summary. Publishing status does not decide whether a package should be versioned. If no package version should change, omit the changeset instead of adding an empty one.

The publish workflow maintains the release pull request and publishes merged versions.
