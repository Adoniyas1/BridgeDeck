#!/bin/bash
# Creates a free, self-signed code-signing certificate ("BridgeDeck Local Signing") in your login
# keychain. Builds signed with the same certificate keep their macOS permissions (Screen Recording,
# Accessibility, Full Disk Access) after updates; ad-hoc signed builds look like a new app every time.
# Run once on the Mac: npm run mac:signing (macOS asks for your password to trust the certificate).
set -euo pipefail
NAME="BridgeDeck Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "\"$NAME\" is already set up."
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF

/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$WORK/cert.cnf" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
PASS="bridgedeck-$RANDOM$RANDOM"
/usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
  -out "$WORK/identity.p12" -passout "pass:$PASS"
security import "$WORK/identity.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null
echo "Trusting the certificate for code signing (macOS asks for your password)…"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"

if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "Done. BridgeDeck updates are now signed with \"$NAME\"."
  echo "Grant Screen Recording, Accessibility and Full Disk Access once more after the next update; they stick from then on."
else
  echo "The certificate was added but macOS doesn't list it for code signing yet." >&2
  exit 1
fi
