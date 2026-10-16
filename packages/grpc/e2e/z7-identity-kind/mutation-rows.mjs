/**
 * The rows of the Z7 kind e2e's mutation proof (mutation-prove.mjs). Pure data,
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
    reason: 'key material appears',
  },
];
