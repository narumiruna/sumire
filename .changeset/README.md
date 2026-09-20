# Changesets

Add a changeset to every pull request.

Create a package changeset with:

```bash
npm run changeset
```

Select each affected package, choose the SemVer bump, and describe the user-visible change. If no package version should change, add an empty changeset instead:

```bash
npm run changeset -- --empty
```

The publish workflow maintains the release pull request and publishes merged versions.
