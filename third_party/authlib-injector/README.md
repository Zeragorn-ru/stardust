# StarDust authlib-injector fork

The launcher must not consume upstream `authlib-injector` unchanged: upstream's
`ProfileKeyFilter` returns the one-byte `AA==` placeholder certificate
signature. `scripts/ci/patch-authlib-injector.py` applies the StarDust patch to a
pinned upstream checkout before Gradle builds it.

The patch has two responsibilities:

- forward `/minecraftservices/player/certificates` to the configured Yggdrasil
  server instead of returning a dummy response;
- validate Minecraft 1.21 `ProfilePublicKey.Data` using the persistent
  Yggdrasil public key while retaining normal message-signature verification.

Pin the upstream commit in the build workflow. Do not update the pin without
running the Paper 1.21.1 integration test, because obfuscated class names and
method descriptors can change between Minecraft versions.
