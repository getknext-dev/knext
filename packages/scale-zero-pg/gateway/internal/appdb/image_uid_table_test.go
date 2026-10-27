package appdb

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// PINNED IMAGE -> RUN-AS UID TABLE.
//
// The compute pods run every container with a numeric runAsUser (the images
// declare their user by NAME, which the kubelet cannot verify as non-root). The
// default uid in DefaultRenderConfig is only right for the digests it ships with,
// so each pinned digest has its uid recorded below, by hand, next to the digest.
//
// Bumping a digest therefore turns this test red until someone has re-read the
// new image's /etc/passwd and recorded the uid:
//
//	crane export --platform linux/amd64 <image@digest> - | tar -xO etc/passwd
//
// There is deliberately no network access here: the table is maintained by hand
// and this test only enforces that it is COMPLETE and consistent with the
// defaults.
var pinnedImageUIDs = map[string]struct{ uid, gid int64 }{
	// compute image: config User "postgres", /etc/passwd postgres:x:1000:1000
	"neondatabase/compute-node-v17:8464@sha256:13ab146d3e7bbabb25a8532f315ac443e7512351d1ede0bab586def5c70e26c3": {1000, 1000},
	// init image (also the storage-plane image): config User "neon", /etc/passwd neon:x:1000:1000
	"neondatabase/neon:8464@sha256:7a4f124917bb929964b2d696d710f19584f80bb9bd51b2af4a6e2425434c761f": {1000, 1000},
}

var pinnedNeonImage = regexp.MustCompile(`neondatabase/(?:compute-node-v[0-9]+|neon):[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}`)

// pinnedRef strips the registry host so the table key is registry-independent.
func pinnedRef(image string) string {
	return pinnedNeonImage.FindString(image)
}

func TestDefaultImagesHaveARecordedUID(t *testing.T) {
	c := DefaultRenderConfig("ns")
	for _, tc := range []struct {
		name, image string
		uid, gid    int64
	}{
		{"compute", c.ComputeImage, c.ComputeUID, c.ComputeGID},
		{"init", c.InitImage, c.InitUID, c.InitGID},
	} {
		ref := pinnedRef(tc.image)
		if ref == "" {
			t.Fatalf("%s image %q is not a digest-pinned neondatabase image; the uid table cannot cover it", tc.name, tc.image)
		}
		want, ok := pinnedImageUIDs[ref]
		if !ok {
			t.Errorf("%s image %s has NO recorded uid in pinnedImageUIDs. Read the new image's /etc/passwd "+
				"(crane export <image> - | tar -xO etc/passwd) and add it, then update the default uid.", tc.name, ref)
			continue
		}
		if tc.uid != want.uid || tc.gid != want.gid {
			t.Errorf("%s image %s: default uid:gid = %d:%d but the image runs as %d:%d", tc.name, ref, tc.uid, tc.gid, want.uid, want.gid)
		}
	}
}

// Every digest pinned in the deploy manifests must also be in the table: the
// static manifests and the break-glass template pin the same images, and a digest
// bumped there alone must not skip the uid re-check.
func TestEveryPinnedNeonImageInDeployHasARecordedUID(t *testing.T) {
	root := filepath.Join("..", "..", "..", "deploy")
	found := map[string][]string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "testdata" {
				return fs.SkipDir
			}
			return nil
		}
		b, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		for _, m := range pinnedNeonImage.FindAllString(string(b), -1) {
			found[m] = append(found[m], filepath.Base(path))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", root, err)
	}
	if len(found) == 0 {
		t.Fatal("found no pinned neondatabase digests under deploy/: the scan would pass vacuously")
	}
	var refs []string
	for r := range found {
		refs = append(refs, r)
	}
	sort.Strings(refs)
	for _, ref := range refs {
		if _, ok := pinnedImageUIDs[ref]; !ok {
			t.Errorf("deploy/ pins %s (in %s) but pinnedImageUIDs has no uid for it", ref, strings.Join(dedupe(found[ref]), ", "))
		}
	}
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
