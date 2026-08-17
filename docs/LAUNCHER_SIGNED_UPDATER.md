# Signed Tauri updater (test channel)

The launcher currently has two update channels:

- **stable**: existing GitHub Releases updater with the legacy compatibility path;
- **tauri-test**: a manually built test binary using Tauri's signed updater plugin.

Stable builds do not request `latest.json` and do not see the `updater-test` prerelease. Existing installed launchers therefore remain compatible while the signed updater is validated.

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

The public key is injected into `tauri.updater-test.conf.json` by CI. Rotate it by publishing a new test channel and rebuilding the test binary; do not replace the key used by already distributed stable binaries.

## Test release

Run **Actions → launcher-updater-test** manually with a unique private tag such as `updater-test-v0.1.0`. The workflow publishes the signed installer and `.sig` under that prerelease, while copying only `latest.json` to the separate `updater-test` prerelease metadata channel. Neither release is included in stable player releases or stable-client update checks.

The workflow requires the GitHub `launcher-release` Environment and the signing secrets above. A test build is compiled with `VITE_LAUNCHER_UPDATE_CHANNEL=tauri-test` and the test config overlay. Normal builds omit that variable and keep the legacy updater.

Before testing, install the generated test binary on a disposable machine. Confirm that the updater downloads only the signed asset and that a mismatched signature aborts before installation. Test rollback by installing a normal stable build; it must continue using the legacy updater.

## Promotion and rollback

Do not promote this channel by changing the stable endpoint until Windows signing, update installation, rollback, and older-launcher compatibility have been verified. If the test channel is withdrawn, delete or replace the `updater-test` prerelease; stable clients are unaffected. The legacy Rust updater and its commands remain in the codebase during the migration window.
