# Changesets

Add a changeset when a pull request changes the published behavior of a package.

Create one with:

```bash
npm run changeset
```

Select each affected package, choose the SemVer bump, and describe the user-visible change. The publish workflow maintains the release pull request and publishes merged versions.
