package hl

import (
	"encoding/hex"
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestPackIntegerForms(t *testing.T) {
	cases := []struct {
		v    any
		want string
	}{
		{0, "00"}, {127, "7f"}, {128, "cc80"}, {255, "ccff"}, {256, "cd0100"},
		{65535, "cdffff"}, {65536, "ce00010000"}, {uint64(math.MaxUint32), "ceffffffff"},
		{uint64(math.MaxUint32) + 1, "cf0000000100000000"}, {uint64(math.MaxUint64), "cfffffffffffffffff"},
		{-1, "ff"}, {-32, "e0"}, {-33, "d0df"}, {-128, "d080"}, {-129, "d1ff7f"},
		{-32768, "d18000"}, {-32769, "d2ffff7fff"}, {int64(math.MinInt32) - 1, "d3ffffffff7fffffff"},
		{int8(5), "05"}, {uint16(300), "cd012c"}, {true, "c3"}, {false, "c2"}, {nil, "c0"},
	}
	for _, c := range cases {
		b, err := Pack(c.v)
		if err != nil {
			t.Fatalf("%v: %v", c.v, err)
		}
		if hex.EncodeToString(b) != c.want {
			t.Fatalf("Pack(%v) = %x, want %s", c.v, b, c.want)
		}
	}
}

func TestPackStringAndContainerForms(t *testing.T) {
	check := func(name string, v any, prefix string) {
		t.Helper()
		b, err := Pack(v)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !strings.HasPrefix(hex.EncodeToString(b), prefix) {
			t.Fatalf("%s: %x does not start with %s", name, b[:min(8, len(b))], prefix)
		}
	}
	check("fixstr 31", strings.Repeat("a", 31), "bf")
	check("str8 32", strings.Repeat("a", 32), "d920")
	check("str8 255", strings.Repeat("a", 255), "d9ff")
	check("str16 256", strings.Repeat("a", 256), "da0100")
	check("bin8", []byte{1, 2, 3}, "c403010203")
	arr15 := make([]any, 15)
	arr16 := make([]any, 16)
	check("fixarray 15", arr15, "9f")
	check("array16 16", arr16, "dc0010")
	var m15, m16 OMap
	for i := 0; i < 16; i++ {
		if i < 15 {
			m15 = append(m15, KV{string(rune('a' + i)), i})
		}
		m16 = append(m16, KV{string(rune('a' + i)), i})
	}
	check("fixmap 15", m15, "8f")
	check("map16 16", m16, "de0010")
	check("typed slice", [][]string{{"SPY", "1.5"}}, "9192a3535059")
	var nilPtr *string
	check("nil pointer", nilPtr, "c0")
}

func TestPackRefusesFloatsAndGoMaps(t *testing.T) {
	if _, err := Pack(OMap{{"px", 0.5}}); err == nil {
		t.Fatal("a float must be refused: amounts are signed as decimal strings")
	}
	if _, err := Pack(map[string]any{"a": 1}); err == nil {
		t.Fatal("a Go map has no order and must be refused")
	}
}

func TestOMapOrderSurvivesJSON(t *testing.T) {
	in := `{"type":"order","orders":[{"a":1,"b":true,"p":"0.5","s":"2","r":false,"t":{"limit":{"tif":"Ioc"}}}],"grouping":"na","n":18446744073709551615,"z":null}`
	m, err := OMapFromJSON([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(m.Keys(), ",") != "type,orders,grouping,n,z" {
		t.Fatalf("keys %v", m.Keys())
	}
	out, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != in {
		t.Fatalf("round trip:\n got %s\nwant %s", out, in)
	}
	if v, _ := m.Get("n"); v != uint64(math.MaxUint64) {
		t.Fatalf("uint64 beyond int64 decoded as %T %v", v, v)
	}
	if _, err := OMapFromJSON([]byte(`[1]`)); err == nil {
		t.Fatal("an array is not an action")
	}
}

func TestUnitsRoundTrip(t *testing.T) {
	cases := []struct {
		units uint64
		dec   int
		s     string
	}{
		{4_500_000_000, 8, "45"}, {50_000_000, 8, "0.5"}, {1, 8, "0.00000001"}, {123, 0, "123"},
		{45_000_000, 6, "45"}, {1_234_567, 6, "1.234567"}, {0, 6, "0"},
	}
	for _, c := range cases {
		if got := FormatUnits(c.units, c.dec); got != c.s {
			t.Fatalf("FormatUnits(%d,%d) = %q, want %q", c.units, c.dec, got, c.s)
		}
		back, err := ParseUnits(c.s, c.dec)
		if err != nil || back != c.units {
			t.Fatalf("ParseUnits(%q,%d) = %d %v", c.s, c.dec, back, err)
		}
	}
	if _, err := ParseUnits("0.0000001", 6); err == nil {
		t.Fatal("excess precision must be refused, never rounded")
	}
	if v, err := ParseUnits("1.500000000", 6); err != nil || v != 1_500_000 {
		t.Fatalf("trailing zeros beyond precision: %d %v", v, err)
	}
	if v, err := SignedUnits("-0.25", 8); err != nil || v != -25_000_000 {
		t.Fatalf("SignedUnits: %d %v", v, err)
	}
}

func TestOutcomeIDs(t *testing.T) {
	if Enc(4242, 1) != 42421 || OutcomeAsset(4242, 1) != 100_042_421 || OutcomeCoin(4, 0) != "#40" || OutcomeToken(4, 1) != "+41" {
		t.Fatal("outcome id packing")
	}
	if o, s, ok := ParseOutcomeToken("+42421"); !ok || o != 4242 || s != 1 {
		t.Fatalf("parse %d %d %v", o, s, ok)
	}
	if _, _, ok := ParseOutcomeToken("+42"); ok {
		t.Fatal("side 2 is not an outcome side")
	}
	if got := SystemAddress(200).Hex(); got != "0x20000000000000000000000000000000000000C8" {
		t.Fatalf("system address %s", got)
	}
	if got := SystemAddress(0).Hex(); got != "0x2000000000000000000000000000000000000000" {
		t.Fatalf("USDC-at-0 system address %s", got)
	}
}
