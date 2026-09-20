# Changesets

Add a changeset to every pull request.

Create a package changeset with:

```bash
npm run changeset
```

Select every affected package, including private packages that will not be published, choose the appropriate SemVer bump, and describe the change. Publishing status does not decide whether a package should be versioned. If no package version should change, add an empty changeset instead:

```bash
npm run changeset -- --empty
```

The publish workflow maintains the release pull request and publishes merged versions.
