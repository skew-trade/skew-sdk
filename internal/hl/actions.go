package hl

import (
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"
)

// ---------------------------------------------------------------- HIP-4 ids

// OutcomeAssetBase is added to an outcome side's encoding to form its asset id
// in order and cancel actions.
const OutcomeAssetBase = 100_000_000

// Enc packs an outcome id and side: 10*outcome + side (side 0 YES, 1 NO).
func Enc(outcome uint32, side uint8) uint64 { return 10*uint64(outcome) + uint64(side) }

// OutcomeAsset is the order/cancel asset id of an outcome side.
func OutcomeAsset(outcome uint32, side uint8) uint64 { return OutcomeAssetBase + Enc(outcome, side) }

// OutcomeCoin is the book coin ("#<enc>") of an outcome side.
func OutcomeCoin(outcome uint32, side uint8) string {
	return "#" + strconv.FormatUint(Enc(outcome, side), 10)
}

// OutcomeToken is the balance name ("+<enc>") of an outcome side.
func OutcomeToken(outcome uint32, side uint8) string {
	return "+" + strconv.FormatUint(Enc(outcome, side), 10)
}

// ParseOutcomeToken decodes "+<enc>" (or "#<enc>").
func ParseOutcomeToken(name string) (outcome uint32, side uint8, ok bool) {
	if len(name) < 2 || (name[0] != '+' && name[0] != '#') {
		return 0, 0, false
	}
	enc, err := strconv.ParseUint(name[1:], 10, 64)
	if err != nil || enc%10 > 1 || enc/10 > 0xffffffff {
		return 0, 0, false
	}
	return uint32(enc / 10), uint8(enc % 10), true
}

// ---------------------------------------------------------------- amounts

// FormatUnits renders an integer amount of base units as the decimal string
// the exchange wants ("45", "0.5", "0.00000001"): no exponent, no trailing
// zeros.
func FormatUnits(units uint64, decimals int) string {
	if decimals <= 0 {
		return strconv.FormatUint(units, 10)
	}
	s := strconv.FormatUint(units, 10)
	if len(s) <= decimals {
		s = strings.Repeat("0", decimals-len(s)+1) + s
	}
	whole, frac := s[:len(s)-decimals], strings.TrimRight(s[len(s)-decimals:], "0")
	if frac == "" {
		return whole
	}
	return whole + "." + frac
}

// ParseUnits is FormatUnits' inverse; it refuses more precision than decimals.
func ParseUnits(s string, decimals int) (uint64, error) {
	s = strings.TrimSpace(s)
	neg := strings.HasPrefix(s, "-")
	if neg {
		return 0, fmt.Errorf("hl: negative amount %q", s)
	}
	whole, frac, _ := strings.Cut(s, ".")
	if len(frac) > decimals {
		if strings.TrimRight(frac[decimals:], "0") != "" {
			return 0, fmt.Errorf("hl: %q has more than %d decimals", s, decimals)
		}
		frac = frac[:decimals]
	}
	frac += strings.Repeat("0", decimals-len(frac))
	if whole == "" {
		whole = "0"
	}
	n, ok := new(big.Int).SetString(whole+frac, 10)
	if !ok || !n.IsUint64() {
		return 0, fmt.Errorf("hl: amount %q", s)
	}
	return n.Uint64(), nil
}

// SignedUnits parses a possibly negative decimal string into base units.
func SignedUnits(s string, decimals int) (int64, error) {
	s = strings.TrimSpace(s)
	neg := strings.HasPrefix(s, "-")
	u, err := ParseUnits(strings.TrimPrefix(s, "-"), decimals)
	if err != nil {
		return 0, err
	}
	if u > 1<<62 {
		return 0, fmt.Errorf("hl: amount %q too large", s)
	}
	if neg {
		return -int64(u), nil
	}
	return int64(u), nil
}

// ---------------------------------------------------------------- L1 actions

// Time-in-force values of a limit order.
const (
	TifGtc = "Gtc"
	TifIoc = "Ioc"
	TifAlo = "Alo"
)

// OrderSpec is one limit order. Px and Sz are decimal strings, exactly as
// they are signed.
type OrderSpec struct {
	Asset      uint64
	IsBuy      bool
	Px         string
	Sz         string
	ReduceOnly bool
	Tif        string
	Cloid      string // optional "0x" + 32 hex
}

func (o OrderSpec) wire() OMap {
	m := OMap{
		{"a", o.Asset}, {"b", o.IsBuy}, {"p", o.Px}, {"s", o.Sz}, {"r", o.ReduceOnly},
		{"t", OMap{{"limit", OMap{{"tif", o.Tif}}}}},
	}
	if o.Cloid != "" {
		m = append(m, KV{"c", strings.ToLower(o.Cloid)})
	}
	return m
}

// Order is the order action, grouping "na", without a builder: the field
// order (type, orders, grouping) and each order's (a, b, p, s, r, t, c) are
// the hyperliquid-python-sdk's.
func Order(orders ...OrderSpec) OMap {
	ws := make([]any, len(orders))
	for i, o := range orders {
		ws[i] = o.wire()
	}
	return OMap{{"type", "order"}, {"orders", ws}, {"grouping", "na"}}
}

// BuilderFee is an order action's builder code: the address that earns the fee and the fee in
// tenths of a basis point (10 = 1 bp). The user's main wallet must have approved at least that
// rate for the builder (ApproveBuilderFee); the field is inside what the user signs.
type BuilderFee struct {
	Builder common.Address
	Tenths  uint64
}

// OrderWithBuilder is the order action carrying a builder code: builder {b, f} follows grouping
// (the hyperliquid-python-sdk's order: type, orders, grouping, builder), b in lowercase.
func OrderWithBuilder(b BuilderFee, orders ...OrderSpec) OMap {
	return append(Order(orders...), KV{"builder", OMap{{"b", strings.ToLower(b.Builder.Hex())}, {"f", b.Tenths}}})
}

// Noop does nothing but spend its nonce: signed with the nonce of an action its signer no longer
// wants sent, it makes that action unusable (the docs' "invalidate pending nonce").
func Noop() OMap { return OMap{{"type", "noop"}} }

// ReserveRequestWeight buys weight requests of address budget at 0.0005 USDC each from the
// signer's perps balance, for destination when it is set (the field is left out of the hash
// when it is not).
func ReserveRequestWeight(weight uint64, destination *common.Address) OMap {
	a := OMap{{"type", "reserveRequestWeight"}, {"weight", weight}}
	if destination != nil {
		a = append(a, KV{"destination", strings.ToLower(destination.Hex())})
	}
	return a
}

// Cancel cancels orders by (asset, oid).
type CancelSpec struct {
	Asset uint64
	Oid   uint64
}

// Cancel is the cancel action: cancels [{a, o}].
func Cancel(cs ...CancelSpec) OMap {
	ws := make([]any, len(cs))
	for i, c := range cs {
		ws[i] = OMap{{"a", c.Asset}, {"o", c.Oid}}
	}
	return OMap{{"type", "cancel"}, {"cancels", ws}}
}

// CancelByCloid cancels one order by client order id: cancels [{asset, cloid}]
// (spelled out in full, unlike cancel).
func CancelByCloid(asset uint64, cloid string) OMap {
	return OMap{{"type", "cancelByCloid"}, {"cancels", []any{OMap{{"asset", asset}, {"cloid", strings.ToLower(cloid)}}}}}
}

// CloidCancel names one order of a cancelByCloid action.
type CloidCancel struct {
	Asset uint64
	Cloid string
}

// CancelByCloids cancels several orders by client order id in ONE action: a maker's cancel of a
// whole book bundle. Each cancel gets its own status in the answer.
func CancelByCloids(cs ...CloidCancel) OMap {
	ws := make([]any, len(cs))
	for i, c := range cs {
		ws[i] = OMap{{"asset", c.Asset}, {"cloid", strings.ToLower(c.Cloid)}}
	}
	return OMap{{"type", "cancelByCloid"}, {"cancels", ws}}
}

// ScheduleCancel arms the dead-man switch at timeMs; nil clears it (the field
// is then omitted, not null).
func ScheduleCancel(timeMs *uint64) OMap {
	if timeMs == nil {
		return OMap{{"type", "scheduleCancel"}}
	}
	return OMap{{"type", "scheduleCancel"}, {"time", *timeMs}}
}

// SplitOutcome mints amount quote tokens into amount YES + amount NO
// (userOutcome.splitOutcome{outcome, amount}).
func SplitOutcome(outcome uint32, amount string) OMap {
	return OMap{{"type", "userOutcome"}, {"splitOutcome", OMap{{"outcome", uint64(outcome)}, {"amount", amount}}}}
}

// MergeOutcome merges amount pairs back into quote tokens.
func MergeOutcome(outcome uint32, amount string) OMap {
	return OMap{{"type", "userOutcome"}, {"mergeOutcome", OMap{{"outcome", uint64(outcome)}, {"amount", amount}}}}
}

// MergeOutcomeMax merges every pair held: amount is an explicit null.
func MergeOutcomeMax(outcome uint32) OMap {
	return OMap{{"type", "userOutcome"}, {"mergeOutcome", OMap{{"outcome", uint64(outcome)}, {"amount", nil}}}}
}

// EvmUserModify routes the signer's HyperEVM transactions to big blocks (or
// back). The signer must already have a Core account.
func EvmUserModify(usingBigBlocks bool) OMap {
	return OMap{{"type", "evmUserModify"}, {"usingBigBlocks", usingBigBlocks}}
}

// ---------------------------------------------------------------- user-signed

// UserSignedOptions are the fields every user-signed action carries.
type UserSignedOptions struct {
	Mainnet bool
	// SignatureChainID defaults to DefaultSignatureChainID.
	SignatureChainID string
}

func (o UserSignedOptions) header(typ string) OMap {
	cid := o.SignatureChainID
	if cid == "" {
		cid = DefaultSignatureChainID
	}
	return OMap{{"type", typ}, {"signatureChainId", cid}, {"hyperliquidChain", chainName(o.Mainnet)}}
}

// SpotSend moves amount of a spot token ("NAME:0x<tokenId>") from the signer's
// spot balance to destination. The nonce is the action's time.
func SpotSend(o UserSignedOptions, destination common.Address, token, amount string, nonce uint64) UserSigned {
	a := append(o.header("spotSend"),
		KV{"destination", strings.ToLower(destination.Hex())},
		KV{"token", token},
		KV{"amount", amount},
		KV{"time", nonce},
	)
	return UserSigned{Type: SpotSendType, Action: a, Nonce: nonce}
}

// ApproveAgent lets agent sign L1 actions (orders, cancels, scheduleCancel) for the signer's
// account; name "" is the unnamed agent. agentName is always on the wire: the reference SDK
// signs "" for an unnamed agent and Hyperliquid reads a missing name as "". An agent cannot
// sign user-signed actions (transfers, withdrawals, approvals).
func ApproveAgent(o UserSignedOptions, agent common.Address, name string, nonce uint64) UserSigned {
	a := append(o.header("approveAgent"),
		KV{"agentAddress", strings.ToLower(agent.Hex())},
		KV{"agentName", name},
		KV{"nonce", nonce},
	)
	return UserSigned{Type: ApproveAgentType, Action: a, Nonce: nonce}
}

// ApproveBuilderFee lets builder charge the signer's orders up to maxFeeRate (a percentage
// string, "0.01%" = 1 bp). User-signed: the account's own key, never an agent. Hyperliquid
// refuses a builder with under 100 USDC of perps account value.
func ApproveBuilderFee(o UserSignedOptions, builder common.Address, maxFeeRate string, nonce uint64) UserSigned {
	a := append(o.header("approveBuilderFee"),
		KV{"maxFeeRate", maxFeeRate},
		KV{"builder", strings.ToLower(builder.Hex())},
		KV{"nonce", nonce},
	)
	return UserSigned{Type: ApproveBuilderFeeType, Action: a, Nonce: nonce}
}

// Dex names for sendAsset: "" is the main perp dex, "spot" the spot balance.
const (
	DexPerp = ""
	DexSpot = "spot"
)

// SendAsset moves amount of token between dexes and accounts. Unified
// accounts, which refuse spotSend, accept it. fromSubAccount is "" for the
// signer itself.
func SendAsset(o UserSignedOptions, destination common.Address, sourceDex, destinationDex, token, amount, fromSubAccount string, nonce uint64) UserSigned {
	a := append(o.header("sendAsset"),
		KV{"destination", strings.ToLower(destination.Hex())},
		KV{"sourceDex", sourceDex},
		KV{"destinationDex", destinationDex},
		KV{"token", token},
		KV{"amount", amount},
		KV{"fromSubAccount", fromSubAccount},
		KV{"nonce", nonce},
	)
	return UserSigned{Type: SendAssetType, Action: a, Nonce: nonce}
}

// UsdClassTransfer moves USDC between the signer's perp and spot balances
// (Standard accounts only). For a sub-account, amount carries the suffix
// " subaccount:0x...".
func UsdClassTransfer(o UserSignedOptions, amount string, toPerp bool, nonce uint64) UserSigned {
	a := append(o.header("usdClassTransfer"),
		KV{"amount", amount},
		KV{"toPerp", toPerp},
		KV{"nonce", nonce},
	)
	return UserSigned{Type: UsdClassTransferType, Action: a, Nonce: nonce}
}

// SystemAddress is a spot token's HyperEVM system address: 0x20 followed by
// the token index, big-endian. A transfer of the token to it on Core lands on
// the sender's own EVM address in the next EVM block.
func SystemAddress(tokenIndex uint64) common.Address {
	var a common.Address
	a[0] = 0x20
	for i := 0; i < 8; i++ {
		a[19-i] = byte(tokenIndex >> (8 * i))
	}
	return a
}

// HYPESystemAddress is HYPE's system address.
var HYPESystemAddress = common.HexToAddress("0x2222222222222222222222222222222222222222")
