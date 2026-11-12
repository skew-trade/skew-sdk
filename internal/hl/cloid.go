package hl

import (
	"encoding/hex"
	"fmt"
	"strings"
)

// ---------------------------------------------------------------- client order ids

// Cloid is a client order id: 16 bytes, "0x" and 32 lowercase hex digits on the wire.
type Cloid [16]byte

// String is the wire form.
func (c Cloid) String() string { return "0x" + hex.EncodeToString(c[:]) }

// IsZero reports an unset cloid.
func (c Cloid) IsZero() bool { return c == Cloid{} }

// ParseCloid reads "0x" + 32 hex digits (either case).
func ParseCloid(s string) (Cloid, error) {
	var c Cloid
	h := strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X")
	if len(h) != 32 || len(s) != 34 {
		return c, fmt.Errorf("hl: cloid %q is not 0x + 32 hex", s)
	}
	if _, err := hex.Decode(c[:], []byte(h)); err != nil {
		return c, fmt.Errorf("hl: cloid %q: %w", s, err)
	}
	return c, nil
}

// MarshalText writes the wire form.
func (c Cloid) MarshalText() ([]byte, error) { return []byte(c.String()), nil }

// UnmarshalText reads the wire form.
func (c *Cloid) UnmarshalText(b []byte) error {
	v, err := ParseCloid(string(b))
	if err != nil {
		return err
	}
	*c = v
	return nil
}
