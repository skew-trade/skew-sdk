// Package hip4 is Hyperliquid's HIP-4 outcome-market rules: the ids of a market side, the price
// tick and the whole-share size, the canonical decimal strings Hyperliquid hashes, and the 1 USDC
// minimum order value.
//
// The facts, each measured on Hyperliquid (October 2026):
//
//   - asset id = 100,000,000 + 10*outcome + side, side 0 YES and 1 NO; the book coin is
//     "#<enc>" and the balance token "+<enc>", enc = 10*outcome + side;
//   - the price tick is 0.00001: "Price must be divisible by tick size" for 0.512345, 0.51234
//     passed;
//   - sizes are whole shares: "Order has invalid size" for 2.5;
//   - every order must be worth at least 1 USDC on its OWN value, size x limit price:
//     "Order must have minimum value of 1 USDC" for 1 @ 0.9, while 2 @ 0.9 passed;
//   - px and sz are signed as canonical strings ("0.9", not "0.90"): any other spelling changes
//     the action hash, and Hyperliquid answers "User or API Wallet 0x... does not exist".
//
// The arithmetic is integer: prices in ticks (1 tick = 0.00001 USDC per share), money in
// micro-USDC, sizes in whole shares.
package hip4

import (
	"errors"
	"fmt"
	"math/big"
	"math/bits"
	"strconv"
	"strings"
)

// The rules' constants.
const (
	// AssetBase is added to a side's encoding to form its asset id in order and cancel actions.
	AssetBase uint64 = 100_000_000
	// TokenBase is the base the spotBalance precompile reads an outcome side's balance at
	// (100,000,000 + enc).
	TokenBase uint64 = 100_000_000
	// PxDecimals is the price's decimal places: the tick is 0.00001.
	PxDecimals = 5
	// Ticks is the number of ticks in 1 USDC: the price of a share that pays 1.
	Ticks Px = 100_000
	// SzDecimals is the size's decimal places: whole shares.
	SzDecimals = 0
	// MicroPerTickShare is one share at one tick, in micro-USDC: 0.00001 USDC = 10 micro-USDC.
	MicroPerTickShare uint64 = 10
	// MinOrderValueMicro is Hyperliquid's smallest order, on the order's own value (size x
	// limit price): 1 USDC.
	MinOrderValueMicro uint64 = 1_000_000
	// TokenWeiPerShare is outcome-token wei per share: the unit of the spotBalance precompile
	// (measured: one share is 1e5 wei).
	TokenWeiPerShare uint64 = 100_000
)

// ---------------------------------------------------------------- sides and ids

// Side is a binary outcome's side as Hyperliquid encodes it: 0 YES, 1 NO.
type Side uint8

const (
	Yes Side = 0
	No  Side = 1
)

// Valid reports whether s is YES or NO.
func (s Side) Valid() bool { return s <= No }

// Other is the complement: a YES buy at p is a NO sale at 1 - p on the merged book.
func (s Side) Other() Side { return 1 - s&1 }

func (s Side) String() string {
	switch s {
	case Yes:
		return "YES"
	case No:
		return "NO"
	}
	return "side(" + strconv.Itoa(int(s)) + ")"
}

// Enc packs an outcome and a side: 10*outcome + side.
func Enc(outcome uint32, side Side) uint64 { return 10*uint64(outcome) + uint64(side) }

// Asset is the order and cancel asset id of an outcome side.
func Asset(outcome uint32, side Side) uint64 { return AssetBase + Enc(outcome, side) }

// Coin is the book coin of an outcome side: "#<enc>".
func Coin(outcome uint32, side Side) string { return "#" + strconv.FormatUint(Enc(outcome, side), 10) }

// Token is the balance name of an outcome side: "+<enc>".
func Token(outcome uint32, side Side) string { return "+" + strconv.FormatUint(Enc(outcome, side), 10) }

// FromEnc unpacks an encoding.
func FromEnc(enc uint64) (outcome uint32, side Side, ok bool) {
	if enc%10 > 1 || enc/10 > 0xffffffff {
		return 0, 0, false
	}
	return uint32(enc / 10), Side(enc % 10), true
}

// FromAsset unpacks an outcome side's asset id.
func FromAsset(asset uint64) (outcome uint32, side Side, ok bool) {
	if asset < AssetBase {
		return 0, 0, false
	}
	return FromEnc(asset - AssetBase)
}

// FromCoin unpacks "#<enc>" (a book coin) or "+<enc>" (a balance token).
func FromCoin(name string) (outcome uint32, side Side, ok bool) {
	if len(name) < 2 || (name[0] != '#' && name[0] != '+') {
		return 0, 0, false
	}
	enc, err := strconv.ParseUint(name[1:], 10, 64)
	if err != nil || strconv.FormatUint(enc, 10) != name[1:] {
		return 0, 0, false
	}
	return FromEnc(enc)
}

// ---------------------------------------------------------------- prices

// Px is a price in ticks: 1 tick is 0.00001 USDC per share. An outcome side trades strictly
// between 0 and 1, so a valid price is 1..99,999.
type Px uint32

// PxFromMilli is a milli price (the book's grid: 450 = 0.450) in ticks.
func PxFromMilli(milli uint32) Px { return Px(milli) * 100 }

// Valid refuses a price outside (0, 1).
func (p Px) Valid() error {
	if p == 0 || p >= Ticks {
		return &Violation{Rule: RulePrice, Detail: fmt.Sprintf("price %s is not strictly between 0 and 1", p)}
	}
	return nil
}

// Milli is the price in milli when it sits on the milli grid.
func (p Px) Milli() (uint32, bool) {
	if p%100 != 0 {
		return 0, false
	}
	return uint32(p / 100), true
}

// Complement is the other side's price at the same merged level: 1 - p.
func (p Px) Complement() Px {
	if p >= Ticks {
		return 0
	}
	return Ticks - p
}

// String is the canonical decimal string Hyperliquid hashes ("0.9", "0.51234").
func (p Px) String() string { return FormatUnits(uint64(p), PxDecimals) }

// ParsePx reads a decimal price (canonical or not) and refuses one off the tick or outside (0, 1).
func ParsePx(s string) (Px, error) {
	u, err := parseDecimal(s, PxDecimals)
	if err != nil {
		if errors.Is(err, errTooPrecise) {
			return 0, &Violation{Rule: RuleTick, Detail: fmt.Sprintf("price %q is not on the 0.00001 tick", s)}
		}
		return 0, &Violation{Rule: RulePrice, Detail: fmt.Sprintf("price %q: %v", s, err)}
	}
	if u >= uint64(Ticks) || u == 0 {
		return 0, &Violation{Rule: RulePrice, Detail: fmt.Sprintf("price %q is not strictly between 0 and 1", s)}
	}
	return Px(u), nil
}

// ---------------------------------------------------------------- sizes

// FormatSz is a size in whole shares as Hyperliquid hashes it ("10").
func FormatSz(sz uint64) string { return strconv.FormatUint(sz, 10) }

// ParseSz reads a decimal size and refuses a fraction of a share.
func ParseSz(s string) (uint64, error) {
	u, err := parseDecimal(s, SzDecimals)
	if err != nil {
		if errors.Is(err, errTooPrecise) {
			return 0, &Violation{Rule: RuleSize, Detail: fmt.Sprintf("size %q is not a whole number of shares", s)}
		}
		return 0, &Violation{Rule: RuleSize, Detail: fmt.Sprintf("size %q: %v", s, err)}
	}
	return u, nil
}

// ---------------------------------------------------------------- canonical strings

// FormatUnits renders units of 10^-decimals as the canonical decimal string: no exponent, no
// sign, no trailing zeros and no trailing point ("45", "0.5", "0.00001").
func FormatUnits(units uint64, decimals int) string {
	s := strconv.FormatUint(units, 10)
	if decimals <= 0 {
		return s
	}
	if len(s) <= decimals {
		s = strings.Repeat("0", decimals-len(s)+1) + s
	}
	whole, frac := s[:len(s)-decimals], strings.TrimRight(s[len(s)-decimals:], "0")
	if frac == "" {
		return whole
	}
	return whole + "." + frac
}

// CanonicalMaxDecimals is how far Hyperliquid's reference signer rounds a number before it
// normalizes it (the Python SDK's float_to_wire: 8 places).
const CanonicalMaxDecimals = 8

// Canonical rewrites a non-negative decimal string the way Hyperliquid's reference signer
// renders a number it hashes (float_to_wire: rounded to 8 places, then normalized): no
// exponent, no sign, one "0" before a point and no other leading zeros, no trailing zeros, no
// trailing point, and "0" for zero. It refuses a sign, an exponent, a stray character and more
// than 8 significant decimal places (the reference signer refuses to round those away).
func Canonical(s string) (string, error) {
	u, err := parseDecimal(s, CanonicalMaxDecimals)
	if err != nil {
		return "", fmt.Errorf("hip4: %q is not a canonical-able decimal: %w", s, err)
	}
	return FormatUnits(u, CanonicalMaxDecimals), nil
}

// IsCanonical reports whether s is already in canonical form.
func IsCanonical(s string) bool {
	c, err := Canonical(s)
	return err == nil && c == s
}

var errTooPrecise = errors.New("more decimal places than allowed")

// parseDecimal reads a plain non-negative decimal ("12", "0.5", ".5", "5.", "007.50") into
// units of 10^-decimals, refusing any non-zero digit beyond `decimals`.
func parseDecimal(s string, decimals int) (uint64, error) {
	if s == "" {
		return 0, errors.New("empty")
	}
	whole, frac, hasPoint := strings.Cut(s, ".")
	if whole == "" && frac == "" {
		return 0, errors.New("no digits")
	}
	if hasPoint && strings.Contains(frac, ".") {
		return 0, errors.New("two decimal points")
	}
	for _, part := range []string{whole, frac} {
		for _, c := range part {
			if c < '0' || c > '9' {
				return 0, fmt.Errorf("%q is not a digit", c)
			}
		}
	}
	if len(frac) > decimals {
		if strings.Trim(frac[decimals:], "0") != "" {
			return 0, errTooPrecise
		}
		frac = frac[:decimals]
	}
	frac += strings.Repeat("0", decimals-len(frac))
	if whole == "" {
		whole = "0"
	}
	n, ok := new(big.Int).SetString(whole+frac, 10)
	if !ok || !n.IsUint64() {
		return 0, errors.New("out of range")
	}
	return n.Uint64(), nil
}

// ---------------------------------------------------------------- values

// ValueMicro is an order's own value, size x limit price, in micro-USDC. It is exact: one
// share at one tick is 10 micro-USDC. It overflows when the value does not fit 64 bits: check
// ValueFits first on a size a client chose.
func ValueMicro(sz uint64, px Px) uint64 { return sz * uint64(px) * MicroPerTickShare }

// ValueFits reports whether ValueMicro(sz, px) is exact: the value fits 64 bits.
func ValueFits(sz uint64, px Px) bool {
	hi, lo := bits.Mul64(sz, uint64(px))
	if hi != 0 {
		return false
	}
	hi, _ = bits.Mul64(lo, MicroPerTickShare)
	return hi == 0
}

// CheckValue refuses an order worth under Hyperliquid's 1 USDC on its own value.
func CheckValue(sz uint64, px Px) error {
	if v := ValueMicro(sz, px); v < MinOrderValueMicro {
		return &Violation{Rule: RuleUserValue, Detail: fmt.Sprintf("%d shares at %s is %s USDC, under the 1 USDC minimum order value",
			sz, px, FormatUnits(v, 6))}
	}
	return nil
}
