/**
 * The rows of the Z7 kind e2e's mutation proof (mutation-prove-operator.sh). Pure data,
 * so tests/z7-identity-kind-e2e-lane.test.ts can check, with no cluster, that
 * every anchor still occurs exactly once in the operator source and that every
 * expected reason is a message run.sh can print: a row whose anchor drifted or
 * whose reason was reworded would otherwise only be found by a 15-minute run.
 *
 * Each row breaks ONE rule in the operator. `file` and `anchor` are the literal
 * source to replace (exactly once); `phases` are the lane phases that must
 * notice; `reason` is a substring the lane's failure must name.
 */

/** Go source uses tabs. */
const T = '\t';

export const ROWS = [
  {
    id: 'M1',
    name: 'bound-ignored',
    // The step that waits the propagation bound: without it, signing switches
    // in the same pass that publishes the new key.
    file: 'packages/kn-next-operator/internal/controller/zone_signing_key.go',
    anchor: 'if due := k.nextPublishedAt.Add(cfg.PropagationBound); in.now.Before(due) {',
    replacement: 'if due := k.nextPublishedAt; in.now.Before(due) {',
    phases: 'deploy rotate',
    reason: 'propagation bound ignored',
  },
  {
    id: 'M2',
    name: 'staged-key-unpublished',
    // The JWKS is derived from the Secret's keys: leave the staged one out.
    file: 'packages/kn-next-operator/internal/controller/zone_signing_key.go',
    anchor: `func (s signingKeySet) publicKeys() []ed25519.PublicKey {\n${T}var out []ed25519.PublicKey\n${T}for _, k := range []*zoneKey{s.current, s.next, s.previous} {`,
    replacement: `func (s signingKeySet) publicKeys() []ed25519.PublicKey {\n${T}var out []ed25519.PublicKey\n${T}for _, k := range []*zoneKey{s.current, nil, s.previous} {`,
    phases: 'deploy rotate',
    reason: 'the JWKS to publish both keys',
  },
  {
    id: 'M3',
    name: 'no-overlap',
    // The previous key is retired the moment it is stamped as switched.
    file: 'packages/kn-next-operator/internal/controller/zone_signing_key.go',
    anchor: 'ZoneKeyOverlap = time.Hour',
    replacement: 'ZoneKeyOverlap = 0',
    phases: 'deploy rotate',
    reason: 'the old key is not kept as previous',
  },
  {
    id: 'M4',
    name: 'staged-key-projected',
    // The zone's key volume also projects the staged next.* key into its pod.
    file: 'packages/kn-next-operator/internal/controller/zone_signing_key.go',
    anchor:
      'for _, k := range []string{signingKeyCurrentKey, signingKeyCurrentKid, signingKeyPreviousKey, signingKeyPreviousKid} {',
    replacement:
      'for _, k := range []string{signingKeyCurrentKey, signingKeyCurrentKid, signingKeyPreviousKey, signingKeyPreviousKid, signingKeyNextKey, signingKeyNextKid} {',
    phases: 'deploy verify',
    reason: 'signing key is not a directory volume of current.*/previous.* only',
  },
  {
    id: 'M5',
    name: 'jwks-subpath',
    // A function mounts the JWKS through a subPath: a rotated file never arrives.
    file: 'packages/kn-next-operator/internal/controller/backendservice_render.go',
    anchor:
      'mounts = append(mounts, corev1.VolumeMount{Name: FunctionJWKSVolumeName, MountPath: ZoneJWKSMountDir, ReadOnly: true})',
    replacement:
      'mounts = append(mounts, corev1.VolumeMount{Name: FunctionJWKSVolumeName, MountPath: ZoneJWKSMountDir + "/" + ZoneJWKSFileName, SubPath: ZoneJWKSFileName, ReadOnly: true})',
    phases: 'deploy verify',
    reason: 'is not mounted as a read-only directory volume',
  },
  {
    id: 'M6',
    name: 'key-in-operator-log',
    // The operator logs the private key it is about to store.
    file: 'packages/kn-next-operator/internal/controller/zone_signing_key_reconcile.go',
    anchor: `case zkWriteSecret:\n${T}${T}${T}if sec, err = r.writeSigningKeySecret(ctx, app, sec, w.keys); err != nil {`,
    replacement: `case zkWriteSecret:\n${T}${T}${T}ctrl.LoggerFrom(ctx).Info("zone key written", "pem", string(w.keys.current.pem))\n${T}${T}${T}if sec, err = r.writeSigningKeySecret(ctx, app, sec, w.keys); err != nil {`,
    phases: 'deploy leaks',
    // Named by the class that matched: the PEM's body lines (the only shape the first
    // scan looked for).
    reason: 'pem-body-line',
  },
  {
    id: 'M6b',
    name: 'key-bytes-in-operator-log',
    // The operator logs the key as the []byte zap prints it (base64 of the PEM, which
    // is also what a Secret's Data holds). A scan of the PEM's body lines misses it.
    file: 'packages/kn-next-operator/internal/controller/zone_signing_key_reconcile.go',
    anchor: `case zkWriteSecret:\n${T}${T}${T}if sec, err = r.writeSigningKeySecret(ctx, app, sec, w.keys); err != nil {`,
    replacement: `case zkWriteSecret:\n${T}${T}${T}ctrl.LoggerFrom(ctx).Info("zone key written", "data", w.keys.current.pem)\n${T}${T}${T}if sec, err = r.writeSigningKeySecret(ctx, app, sec, w.keys); err != nil {`,
    phases: 'deploy leaks',
    reason: 'pem-std',
  },
  {
    id: 'M6c',
    name: 'jwk-d-in-operator-log',
    // The operator prints a JWK with its private member: `d` is the 32-byte seed in
    // unpadded base64url. Neither the PEM's body lines nor its base64 contain it.
    file: 'packages/kn-next-operator/internal/controller/zone_signing_key.go',
    anchor: `${T}der, err := x509.MarshalPKCS8PrivateKey(priv)`,
    replacement: `${T}fmt.Println("jwk", fmt.Sprintf("{\\"kty\\":\\"OKP\\",\\"crv\\":\\"Ed25519\\",\\"d\\":%q}", base64.RawURLEncoding.EncodeToString(priv.Seed())))\n${T}der, err := x509.MarshalPKCS8PrivateKey(priv)`,
    phases: 'deploy leaks',
    reason: 'seed-url-nopad',
  },
  {
    id: 'M7',
    name: 'watcher-dies-early',
    // The lane's own watcher stops after three rounds: "no call failed" would then
    // cover only the start of the rotation. The row mutates the lane, not the
    // operator (the tool runs it the same way).
    file: 'packages/grpc/e2e/z7-identity-kind/run.sh',
    anchor: '      echo "$(date +%s) ${c1} ${c2} ${c3}" >>"${watch_log}"',
    replacement:
      '      echo "$(date +%s) ${c1} ${c2} ${c3}" >>"${watch_log}"\n      [ "${i}" -lt 3 ] || exit 0',
    phases: 'deploy rotate',
    reason: 'the watcher stopped early',
  },
];
