# Signed Tauri updater (test channel)

The launcher has two signed-updater channels plus an emergency fallback:

- **stable**: normal player releases use Tauri's signed updater and the stable `latest.json` endpoint;
- **tauri-test**: manually built prereleases validate the same updater against the private test channel;
- **legacy**: emergency rollback only; it uses the original GitHub Releases updater.

Stable releases continue publishing the legacy NSIS installer, `bootstrap.exe`, and SHA-256 files in addition to `latest.json` and Tauri signatures. This dual publication is required for migration: launchers from 0.8.x cannot understand Tauri metadata, so they first update through the legacy path to a migrated stable build. Do not remove the legacy assets until the old-client migration window is over.

## Key material

Generate a keypair with the Tauri CLI on a trusted workstation:

```sh
cd launcher
npm run tauri signer generate -w stardust-updater.key
```

Never commit the private key. Store the private key content and its password in the GitHub Environment used by the manual updater workflow:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `STARDUST_UPDATER_PUBLIC_KEY`

The test public key is injected into `tauri.updater-test.conf.json` by CI; the stable public key is checked into the stable Tauri config. Rotate keys only with a planned migration: already distributed binaries cannot verify updates signed by a different key.

## Test release

Run **Actions → launcher-updater-test** manually with a unique private tag such as `updater-test-v0.1.0`. The workflow publishes the signed installer and `.sig` under that prerelease, while copying only `latest.json` to the separate `updater-test` prerelease metadata channel. Neither release is included in stable player releases or stable-client update checks.

The workflow requires the GitHub `launcher-release` Environment and the signing secrets above. A test build is compiled with `VITE_LAUNCHER_UPDATE_CHANNEL=tauri-test` and the test config overlay. Stable release CI uses the base config, `VITE_LAUNCHER_UPDATE_CHANNEL=stable`, and the same signing key. Set `VITE_LAUNCHER_UPDATE_CHANNEL=legacy` only for an emergency rollback build; it is not the normal stable mode.

Before testing, install the generated test binary on a disposable machine. Confirm that the updater downloads only the signed asset and that a mismatched signature aborts before installation. Stable builds use the signed endpoint; set the channel to `legacy` only for an emergency rollback build.

## Promotion and rollback

The stable channel is now configured for signed updates. Keep publishing legacy installer/bootstrap/checksum assets and keep the legacy Rust commands during the migration window. If the test channel is withdrawn, delete or replace the `updater-test` prerelease; stable clients are unaffected. Do not remove the legacy assets until an old-client upgrade has been verified in a real stable release.
