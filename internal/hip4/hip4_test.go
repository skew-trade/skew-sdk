package hip4

import "testing"

func TestIDs(t *testing.T) {
	cases := []struct {
		outcome      uint32
		side         Side
		asset        uint64
		coin, token  string
		enc          uint64
		otherOutcome bool
	}{
		{23426, Yes, 100234260, "#234260", "+234260", 234260, false},
		{23426, No, 100234261, "#234261", "+234261", 234261, false},
		{4242, Yes, 100042420, "#42420", "+42420", 42420, false},
		{1, No, 100000011, "#11", "+11", 11, false},
	}
	for _, c := range cases {
		if got := Asset(c.outcome, c.side); got != c.asset {
			t.Errorf("Asset(%d,%v) = %d, want %d", c.outcome, c.side, got, c.asset)
		}
		if got := Coin(c.outcome, c.side); got != c.coin {
			t.Errorf("Coin = %s, want %s", got, c.coin)
		}
		if got := Token(c.outcome, c.side); got != c.token {
			t.Errorf("Token = %s, want %s", got, c.token)
		}
		if o, s, ok := FromAsset(c.asset); !ok || o != c.outcome || s != c.side {
			t.Errorf("FromAsset(%d) = %d %v %v", c.asset, o, s, ok)
		}
		for _, name := range []string{c.coin, c.token} {
			if o, s, ok := FromCoin(name); !ok || o != c.outcome || s != c.side {
				t.Errorf("FromCoin(%s) = %d %v %v", name, o, s, ok)
			}
		}
	}
	for _, bad := range []string{"", "#", "+", "#12", "#-10", "#010", "@10", "#1a0", "#99999999999"} {
		if _, _, ok := FromCoin(bad); ok {
			t.Errorf("FromCoin(%q) accepted", bad)
		}
	}
	if _, _, ok := FromAsset(42); ok {
		t.Error("FromAsset below the base accepted")
	}
	if Yes.Other() != No || No.Other() != Yes || !No.Valid() || Side(2).Valid() {
		t.Error("side helpers")
	}
}

func TestCanonical(t *testing.T) {
	cases := []struct{ in, want string }{
		{"0.9", "0.9"},
		{"0.90", "0.9"},
		{"0.900000", "0.9"},
		{".9", "0.9"},
		{"00.9", "0.9"},
		{"10", "10"},
		{"10.0", "10"},
		{"10.", "10"},
		{"100", "100"},
		{"0", "0"},
		{"0.0", "0"},
		{"000", "0"},
		{"0.51234", "0.51234"},
		{"0.00001", "0.00001"},
		{"1.00000000", "1"},
		{"0.12345678", "0.12345678"},
		{"0.123456780", "0.12345678"},
		{"12.5", "12.5"},
	}
	for _, c := range cases {
		got, err := Canonical(c.in)
		if err != nil || got != c.want {
			t.Errorf("Canonical(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
		if IsCanonical(c.in) != (c.in == c.want) {
			t.Errorf("IsCanonical(%q) = %v", c.in, IsCanonical(c.in))
		}
	}
	for _, bad := range []string{"", ".", "-1", "+1", "1e3", "0x10", "1,5", "1.2.3", " 1", "0.123456789", "abc"} {
		if _, err := Canonical(bad); err == nil {
			t.Errorf("Canonical(%q) accepted", bad)
		}
	}
}

func TestPx(t *testing.T) {
	cases := []struct {
		s     string
		ticks Px
		canon string
	}{
		{"0.9", 90000, "0.9"},
		{"0.90", 90000, "0.9"},
		{"0.51234", 51234, "0.51234"},
		{"0.00001", 1, "0.00001"},
		{"0.99999", 99999, "0.99999"},
		{"0.452", 45200, "0.452"},
	}
	for _, c := range cases {
		p, err := ParsePx(c.s)
		if err != nil || p != c.ticks || p.String() != c.canon {
			t.Errorf("ParsePx(%q) = %d (%s), %v; want %d %s", c.s, p, p, err, c.ticks, c.canon)
		}
	}
	for _, c := range []struct {
		s    string
		rule Rule
	}{{"0.512345", RuleTick}, {"1", RulePrice}, {"0", RulePrice}, {"1.5", RulePrice}, {"-0.5", RulePrice}, {"", RulePrice}} {
		_, err := ParsePx(c.s)
		v, ok := AsViolation(err)
		if !ok || v.Rule != c.rule {
			t.Errorf("ParsePx(%q) = %v, want rule %s", c.s, err, c.rule)
		}
	}
	if PxFromMilli(450) != 45000 || PxFromMilli(450).String() != "0.45" {
		t.Error("PxFromMilli")
	}
	if m, ok := Px(45000).Milli(); !ok || m != 450 {
		t.Error("Milli on the grid")
	}
	if _, ok := Px(45001).Milli(); ok {
		t.Error("Milli off the grid")
	}
	if Px(45000).Complement() != 55000 || Px(51234).Complement().String() != "0.48766" {
		t.Error("Complement")
	}
}

func TestSz(t *testing.T) {
	for _, c := range []struct {
		s    string
		want uint64
	}{{"10", 10}, {"10.0", 10}, {"2", 2}, {"0", 0}} {
		got, err := ParseSz(c.s)
		if err != nil || got != c.want {
			t.Errorf("ParseSz(%q) = %d, %v", c.s, got, err)
		}
	}
	_, err := ParseSz("2.5")
	if v, ok := AsViolation(err); !ok || v.Rule != RuleSize {
		t.Errorf("ParseSz(2.5) = %v, want a size violation", err)
	}
	if FormatSz(100) != "100" {
		t.Error("FormatSz")
	}
}

// The measured minimum: 1 @ 0.9 refused, 2 @ 0.9 passed (11 Oct).
func TestCheckValue(t *testing.T) {
	if err := CheckValue(1, 90000); err == nil {
		t.Error("1 @ 0.9 passed")
	}
	if err := CheckValue(2, 90000); err != nil {
		t.Errorf("2 @ 0.9: %v", err)
	}
	if err := CheckValue(12, 10000); err != nil {
		t.Errorf("12 @ 0.1: %v", err)
	}
	if err := CheckValue(9, 10000); err == nil {
		t.Error("9 @ 0.1 passed")
	}
	if ValueMicro(3, 50000) != 1_500_000 {
		t.Error("ValueMicro")
	}
}
