package heldsigntest_test

import (
	"bytes"
	"os"
	"testing"

	"github.com/skew-trade/skew-sdk/heldsign/heldsigntest"
)

// The vectors re-run from the exported package: every byte of every vector, signed through
// heldsign as another module calls it.
func TestTheExportedSignerReproducesTheVectors(t *testing.T) {
	if err := heldsigntest.Check(); err != nil {
		t.Fatal(err)
	}
}

// The embedded copy is testdata/held_vectors.json: a vendored package carries no testdata, and the
// copy must never drift from what the TypeScript client reproduces.
func TestTheEmbeddedVectorsAreTheRepositorys(t *testing.T) {
	want, err := os.ReadFile("../../testdata/held_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(heldsigntest.Vectors(), want) {
		t.Fatal("heldsign/heldsigntest/held_vectors.json differs from testdata/held_vectors.json")
	}
}
