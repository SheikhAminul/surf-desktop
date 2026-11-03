# Releasing Surf for desktop

Releases are built by `.github/workflows/release.yml` when a tag `vX.Y.Z` is pushed. It makes installers for macOS
(Apple silicon and Intel), Windows and Linux from this repository and the `main` branches of surf-app, surf-core and
surf-extension, signs each update artifact, and uploads everything with `latest.json` (the updater's feed) to a
**draft** release. Publishing the draft is what makes installed apps offer the update.

## Once: the update signing key

Installed apps install an update only if its signature verifies against the public key built into them. Make the key
pair on a computer you trust, and keep the private key out of the repository:

```bash
pnpm tauri signer generate -w ~/.tauri/surf-updates.key
```

In the GitHub repository's settings:

| Where               | Name                                 | Value                                                                                       |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Secrets → Actions   | `TAURI_SIGNING_PRIVATE_KEY`          | the contents of `~/.tauri/surf-updates.key`                                               |
| Secrets → Actions   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password (if you set one)                                                               |
| Variables → Actions | `TAURI_UPDATER_PUBKEY`               | the contents of `~/.tauri/surf-updates.key.pub`                                           |
| Secrets → Actions   | `REPOS_TOKEN`                        | only if surf-app, surf-core or surf-extension are private: a token that can read them |

Back up the private key and its password. Without them, no new release can update the apps already installed. If the
private key leaks, make a new key pair, release a version with the new public key, and revoke the old secret.

The public key is added to release builds only (`tauri.release.conf.json`, written by the workflow), so development
builds don't update themselves and build without the private key.

## Optional: code signing

Unsigned builds work, but macOS Gatekeeper and Windows SmartScreen warn before opening them.

- **macOS**: set the secrets `APPLE_CERTIFICATE` (base64 of the Developer ID Application `.p12`),
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and for notarization `APPLE_ID`, `APPLE_PASSWORD` (an
  app-specific password) and `APPLE_TEAM_ID`. The bundled Node.js runtime is signed with the app, with the JIT
  entitlements in `src-tauri/Entitlements.plist`.
- **Windows**: see Tauri's guide to Windows code signing; add the settings to `bundle.windows` in `tauri.conf.json`.

## Each release

1. Update `version` in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`.
2. Merge to `main`, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. When the workflow finishes, check the draft release (try an installer), write its notes (the updater shows them),
   and publish it.

The feed is `https://github.com/SheikhAminul/surf-desktop/releases/latest/download/latest.json`, so only the latest
published release is offered.
