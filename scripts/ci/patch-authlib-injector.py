#!/usr/bin/env python3
"""Apply StarDust's profile-key support to a pinned authlib-injector checkout."""
from pathlib import Path
import sys

ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()

profile_filter = ROOT / "src/main/java/moe/yushi/authlibinjector/httpd/ProfileKeyFilter.java"
profile_filter.write_text(r'''/*
 * StarDust profile-key forwarding patch.
 *
 * The upstream injector returned AA== here. Forwarding the request lets the
 * configured Yggdrasil server issue a real certificate for custom accounts.
 */
package moe.yushi.authlibinjector.httpd;

import java.io.IOException;
import java.util.Optional;
import moe.yushi.authlibinjector.internal.fi.iki.elonen.IHTTPSession;
import moe.yushi.authlibinjector.internal.fi.iki.elonen.Response;

public class ProfileKeyFilter implements URLFilter {

    @Override
    public boolean canHandle(String domain) {
        return domain.equals("api.minecraftservices.com");
    }

    @Override
    public Optional<Response> handle(URLProcessor urlProcessor, String domain, String path,
            IHTTPSession session) throws IOException {
        if (domain.equals("api.minecraftservices.com")
                && path.equals("/player/certificates")
                && session.getMethod().equals("POST")) {
            String target = urlProcessor.redirect(domain, path)
                    .orElseThrow(() -> new IOException("Yggdrasil redirect is unavailable"));
            return Optional.of(urlProcessor.reverseProxyTo(session, target));
        }
        return Optional.empty();
    }
}
''')

url_processor = ROOT / "src/main/java/moe/yushi/authlibinjector/httpd/URLProcessor.java"
text = url_processor.read_text()
marker = "\n}\n"
helpers = r'''

	Optional<String> redirect(String domain, String path) {
		return redirector.redirect(domain, path);
	}

	Response reverseProxyTo(IHTTPSession session, String upstream) throws IOException {
		return reverseProxy(session, upstream);
	}
'''
if "Response reverseProxyTo(IHTTPSession" not in text:
    pos = text.rfind(marker)
    if pos < 0:
        raise SystemExit("URLProcessor closing brace not found")
    text = text[:pos] + helpers + text[pos:]
    url_processor.write_text(text)

transform = ROOT / "src/main/java/moe/yushi/authlibinjector/transform/support/YggdrasilKeyTransformUnit.java"
text = transform.read_text()
text = text.replace(
    "import java.io.IOException;\n",
    "import java.io.IOException;\nimport java.lang.reflect.Method;\nimport java.nio.ByteBuffer;\nimport java.nio.ByteOrder;\n",
    1,
)
text = text.replace(
    "import java.security.Signature;\n",
    "import java.security.Signature;\nimport java.time.Instant;\nimport java.util.Arrays;\n",
    1,
)
callback = r'''

	@CallbackMethod
		/** Verify Minecraft 1.21 ProfilePublicKey.Data with the Yggdrasil key. */
	public static boolean verifyProfileKey(Object data, java.util.UUID profileId) {
		try {
			Instant expiresAt = (Instant) accessor(data, "expiresAt", "b");
			PublicKey publicKey = (PublicKey) accessor(data, "key", "c");
			byte[] signatureBytes = (byte[]) accessor(data, "keySignature", "d");
			byte[] encodedKey = publicKey.getEncoded();
			byte[] payload = ByteBuffer.allocate(24 + encodedKey.length)
					.order(ByteOrder.BIG_ENDIAN)
					.putLong(profileId.getMostSignificantBits())
					.putLong(profileId.getLeastSignificantBits())
					.putLong(expiresAt.toEpochMilli())
					.put(encodedKey)
					.array();

			for (PublicKey customKey : PUBLIC_KEYS) {
				try {
					Signature verifier = Signature.getInstance("SHA1withRSA");
					verifier.initVerify(customKey);
					verifier.update(payload);
					if (verifier.verify(signatureBytes)) return true;
				} catch (GeneralSecurityException ignored) {
					// Try the next configured Yggdrasil key.
				}
			}
		} catch (ReflectiveOperationException | RuntimeException e) {
			Logging.log(DEBUG, "Failed to inspect profile public key", e);
		}
		return false;
	}

	private static Object accessor(Object target, String... names) throws ReflectiveOperationException {
		for (String name : names) {
			try {
				Method method = target.getClass().getDeclaredMethod(name);
				method.setAccessible(true);
				return method.invoke(target);
			} catch (NoSuchMethodException ignored) {
				// Try the obfuscated or mapped accessor name.
			}
		}
		throw new NoSuchMethodException(Arrays.toString(names));
	}
'''
if "verifyProfileKey(Object data" not in text:
    marker = "\n\t@Override\n\tpublic Optional<ClassVisitor> transform"
    if marker not in text:
        raise SystemExit("transform method marker not found")
    text = text.replace(marker, callback + marker, 1)
branch = r'''
		} else if ("net.minecraft.world.entity.player.ProfilePublicKey$Data".equals(className)
				|| "cna$a".equals(className)) {
			return Optional.of(new ClassVisitor(ASM9, writer) {
				@Override
				public MethodVisitor visitMethod(int access, String name, String desc, String signature, String[] exceptions) {
					if (("validateSignature".equals(name) || "a".equals(name))
							&& desc.endsWith("Ljava/util/UUID;)Z")) {
						ctx.markModified();
						MethodVisitor mv = super.visitMethod(access, name, desc, signature, exceptions);
						mv.visitCode();
						mv.visitVarInsn(ALOAD, 0);
						// validateSignature(UUID) has `this` at slot 0 and its only argument at slot 1.
							mv.visitVarInsn(ALOAD, 1);
						ctx.invokeCallback(mv, YggdrasilKeyTransformUnit.class, "verifyProfileKey");
						mv.visitInsn(IRETURN);
						mv.visitMaxs(-1, -1);
						mv.visitEnd();
						return null;
					}
					return super.visitMethod(access, name, desc, signature, exceptions);
				}
			});
'''
if '"cna$a".equals(className)' not in text:
    end = "\t\t} else {\n\t\t\treturn Optional.empty();"
    if end not in text:
        raise SystemExit("transform fallback marker not found")
    text = text.replace(end, branch + end, 1)
transform.write_text(text)