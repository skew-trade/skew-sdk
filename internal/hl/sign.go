package hl

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/skew-trade/skew-sdk/internal/eip712"
)

// Signer signs a precomputed 32-byte digest and returns r||s||v (v in {0,1}
// or {27,28}). It is eip712.DigestSigner: a key in memory
// (heldsign.KeySigner) or an MPC/HSM signer plugs in behind the same shape. Keys never enter this
// package.
type Signer = eip712.DigestSigner

// Signature is the {r, s, v} an /exchange request carries: r and s as minimal
// 0x-hex (what the reference SDK emits and the exchange accepts), v 27/28.
type Signature struct {
	R string `json:"r"`
	S string `json:"s"`
	V int    `json:"v"`
}

// SignatureFromBytes converts a 65-byte r||s||v signature to the wire form.
func SignatureFromBytes(sig []byte) (Signature, error) {
	if len(sig) != 65 {
		return Signature{}, fmt.Errorf("hl: signature is %d bytes, want 65", len(sig))
	}
	v := int(sig[64])
	if v < 27 {
		v += 27
	}
	if v != 27 && v != 28 {
		return Signature{}, fmt.Errorf("hl: signature v=%d", sig[64])
	}
	return Signature{
		R: hexutil.EncodeBig(new(big.Int).SetBytes(sig[:32])),
		S: hexutil.EncodeBig(new(big.Int).SetBytes(sig[32:64])),
		V: v,
	}, nil
}

// Bytes returns r||s||v with v in {27, 28}. It accepts zero-padded or minimal
// hex for r and s.
func (s Signature) Bytes() ([]byte, error) {
	r, err := parseScalar(s.R)
	if err != nil {
		return nil, fmt.Errorf("hl: r: %w", err)
	}
	ss, err := parseScalar(s.S)
	if err != nil {
		return nil, fmt.Errorf("hl: s: %w", err)
	}
	v := s.V
	if v < 27 {
		v += 27
	}
	if v != 27 && v != 28 {
		return nil, fmt.Errorf("hl: signature v=%d", s.V)
	}
	out := make([]byte, 65)
	r.FillBytes(out[:32])
	ss.FillBytes(out[32:64])
	out[64] = byte(v)
	return out, nil
}

func parseScalar(h string) (*big.Int, error) {
	h = strings.TrimPrefix(strings.TrimPrefix(h, "0x"), "0X")
	if h == "" || len(h) > 64 {
		return nil, errors.New("not a 256-bit hex scalar")
	}
	n, ok := new(big.Int).SetString(h, 16)
	if !ok {
		return nil, errors.New("not hex")
	}
	return n, nil
}

// secp256k1's group order n, and n/2: EIP-2's bound on s.
var (
	secpN     = crypto.S256().Params().N
	secpHalfN = new(big.Int).Rsh(secpN, 1)
)

// Canonical is s in the one form Skew stores and submits: v 27 or 28 (0 or 1 mapped up), s in the
// lower half of the curve order (EIP-2: a high s becomes n - s with v flipped, the same signature
// by the same signer, as Hyperliquid's SDKs sign), r and s as minimal hex. A signature that does
// not parse, or whose r or s is 0 or not under n, is refused. heldsign uses this one function.
func (s Signature) Canonical() (Signature, error) {
	b, err := s.Bytes()
	if err != nil {
		return Signature{}, err
	}
	r, ss, v := new(big.Int).SetBytes(b[:32]), new(big.Int).SetBytes(b[32:64]), b[64]
	if r.Sign() == 0 || r.Cmp(secpN) >= 0 || ss.Sign() == 0 || ss.Cmp(secpN) >= 0 {
		return Signature{}, errors.New("r or s outside 1..n-1")
	}
	if ss.Cmp(secpHalfN) > 0 {
		ss, v = new(big.Int).Sub(secpN, ss), 27+28-v
	}
	return Signature{R: hexutil.EncodeBig(r), S: hexutil.EncodeBig(ss), V: int(v)}, nil
}

// Recover returns the address that signed digest.
func (s Signature) Recover(digest common.Hash) (common.Address, error) {
	b, err := s.Bytes()
	if err != nil {
		return common.Address{}, err
	}
	b[64] -= 27
	pub, err := crypto.SigToPub(digest[:], b)
	if err != nil {
		return common.Address{}, err
	}
	return crypto.PubkeyToAddress(*pub), nil
}

func sign(s Signer, digest common.Hash) (Signature, error) {
	raw, err := s.SignDigest(digest)
	if err != nil {
		return Signature{}, fmt.Errorf("hl: sign: %w", err)
	}
	return SignatureFromBytes(raw)
}

// ---------------------------------------------------------------- L1 actions

// L1 domain: the phantom agent is signed under chain id 1337 on every network;
// the network is the agent's `source` ("a" mainnet, "b" testnet).
var (
	l1Domain = eip712.Domain{Name: "Exchange", Version: "1", ChainID: big.NewInt(1337)}

	agentTypeHash = crypto.Keccak256Hash([]byte("Agent(string source,bytes32 connectionId)"))
)

// L1Options are the optional fields an L1 signature commits to.
type L1Options struct {
	// VaultAddress signs on behalf of a vault or sub-account. Nil for none.
	VaultAddress *common.Address
	// ExpiresAfter (ms) makes the exchange reject the action afterwards. Use
	// it on every relayed L1 action.
	ExpiresAfter *uint64
}

// ActionHash is keccak256(msgpack(action) || be64(nonce) || vault marker
// || [0x00 || be64(expiresAfter)]): the phantom agent's connectionId.
func ActionHash(action any, nonce uint64, o L1Options) (common.Hash, error) {
	data, err := Pack(action)
	if err != nil {
		return common.Hash{}, err
	}
	data = binary.BigEndian.AppendUint64(data, nonce)
	if o.VaultAddress == nil {
		data = append(data, 0x00)
	} else {
		data = append(data, 0x01)
		data = append(data, o.VaultAddress[:]...)
	}
	if o.ExpiresAfter != nil {
		data = append(data, 0x00)
		data = binary.BigEndian.AppendUint64(data, *o.ExpiresAfter)
	}
	return crypto.Keccak256Hash(data), nil
}

// L1Digest is the EIP-712 digest of the phantom agent for action.
func L1Digest(action any, nonce uint64, o L1Options, mainnet bool) (digest, actionHash common.Hash, err error) {
	actionHash, err = ActionHash(action, nonce, o)
	if err != nil {
		return common.Hash{}, common.Hash{}, err
	}
	source := "b"
	if mainnet {
		source = "a"
	}
	structHash := crypto.Keccak256Hash(agentTypeHash[:], crypto.Keccak256([]byte(source)), actionHash[:])
	return eip712.TypedDataHash(l1Domain.Separator(), structHash), actionHash, nil
}

// SignL1 signs an L1 action (order, cancel, userOutcome, ...).
func SignL1(s Signer, action any, nonce uint64, o L1Options, mainnet bool) (Signature, error) {
	digest, _, err := L1Digest(action, nonce, o, mainnet)
	if err != nil {
		return Signature{}, err
	}
	return sign(s, digest)
}

// ---------------------------------------------------------------- user-signed

// DefaultSignatureChainID is what the reference SDK writes into
// signatureChainId (0x66eee = 421614). A wallet that signs while connected to
// another chain uses that chain's id (Skew's front end: 42161); the EIP-712
// domain's chainId is always this field's value.
const DefaultSignatureChainID = "0x66eee"

// Field is one EIP-712 field of a user-signed action.
type Field struct {
	Name string
	Type string // string | address | bool | uint64 | bytes32
}

// UserSignedType is a user-signed action's EIP-712 primary type and fields.
// Field order is part of the signature and differs from the wire order.
type UserSignedType struct {
	Primary string
	Fields  []Field
}

// TypeString is the EIP-712 encodeType string.
func (t UserSignedType) TypeString() string {
	parts := make([]string, len(t.Fields))
	for i, f := range t.Fields {
		parts[i] = f.Type + " " + f.Name
	}
	return t.Primary + "(" + strings.Join(parts, ",") + ")"
}

// The user-signed types this client builds (hyperliquid-python-sdk
// SPOT_TRANSFER_SIGN_TYPES, SEND_ASSET_SIGN_TYPES, USD_CLASS_TRANSFER_SIGN_TYPES).
var (
	SpotSendType = UserSignedType{"HyperliquidTransaction:SpotSend", []Field{
		{"hyperliquidChain", "string"}, {"destination", "string"}, {"token", "string"},
		{"amount", "string"}, {"time", "uint64"},
	}}
	SendAssetType = UserSignedType{"HyperliquidTransaction:SendAsset", []Field{
		{"hyperliquidChain", "string"}, {"destination", "string"}, {"sourceDex", "string"},
		{"destinationDex", "string"}, {"token", "string"}, {"amount", "string"},
		{"fromSubAccount", "string"}, {"nonce", "uint64"},
	}}
	UsdClassTransferType = UserSignedType{"HyperliquidTransaction:UsdClassTransfer", []Field{
		{"hyperliquidChain", "string"}, {"amount", "string"}, {"toPerp", "bool"}, {"nonce", "uint64"},
	}}
	// ApproveAgentType is the reference SDK's sign_agent types: an account approves an agent
	// (an API wallet) that may sign its L1 actions.
	ApproveAgentType = UserSignedType{"HyperliquidTransaction:ApproveAgent", []Field{
		{"hyperliquidChain", "string"}, {"agentAddress", "address"}, {"agentName", "string"}, {"nonce", "uint64"},
	}}
	// ApproveBuilderFeeType is the reference SDK's sign_approve_builder_fee types.
	ApproveBuilderFeeType = UserSignedType{"HyperliquidTransaction:ApproveBuilderFee", []Field{
		{"hyperliquidChain", "string"}, {"maxFeeRate", "string"}, {"builder", "address"}, {"nonce", "uint64"},
	}}
)

// UserSigned is a user-signed action: Action is the wire body (an OMap that
// includes type, signatureChainId and hyperliquidChain) and also the EIP-712
// message; only the fields Type declares are hashed.
type UserSigned struct {
	Type   UserSignedType
	Action OMap
	Nonce  uint64 // the /exchange request nonce (the action's time or nonce field)
}

func chainName(mainnet bool) string {
	if mainnet {
		return "Mainnet"
	}
	return "Testnet"
}

// Digest is the EIP-712 digest of the action under the
// HyperliquidSignTransaction domain whose chainId is signatureChainId.
func (u UserSigned) Digest() (common.Hash, error) {
	return UserSignedDigest(u.Type, u.Action)
}

// UserSignedDigest hashes msg as typ under the HyperliquidSignTransaction
// domain. msg must carry signatureChainId and every field typ declares.
func UserSignedDigest(typ UserSignedType, msg OMap) (common.Hash, error) {
	cidRaw, ok := msg.Get("signatureChainId")
	if !ok {
		return common.Hash{}, errors.New("hl: user-signed action without signatureChainId")
	}
	cidStr, ok := cidRaw.(string)
	if !ok {
		return common.Hash{}, fmt.Errorf("hl: signatureChainId %v is not a string", cidRaw)
	}
	cid, err := strconv.ParseUint(strings.TrimPrefix(strings.ToLower(cidStr), "0x"), 16, 64)
	if err != nil {
		return common.Hash{}, fmt.Errorf("hl: signatureChainId %q: %w", cidStr, err)
	}
	dom := eip712.Domain{Name: "HyperliquidSignTransaction", Version: "1", ChainID: new(big.Int).SetUint64(cid)}
	enc := [][]byte{crypto.Keccak256([]byte(typ.TypeString()))}
	for _, f := range typ.Fields {
		v, ok := msg.Get(f.Name)
		if !ok {
			return common.Hash{}, fmt.Errorf("hl: %s: field %q missing", typ.Primary, f.Name)
		}
		w, err := encodeField(f, v)
		if err != nil {
			return common.Hash{}, fmt.Errorf("hl: %s.%s: %w", typ.Primary, f.Name, err)
		}
		enc = append(enc, w)
	}
	return eip712.TypedDataHash(dom.Separator(), crypto.Keccak256Hash(enc...)), nil
}

func encodeField(f Field, v any) ([]byte, error) {
	switch f.Type {
	case "string":
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("want a string, got %T", v)
		}
		return crypto.Keccak256([]byte(s)), nil
	case "address":
		s, ok := v.(string)
		if !ok || !common.IsHexAddress(s) {
			return nil, fmt.Errorf("want a hex address, got %v", v)
		}
		return common.LeftPadBytes(common.HexToAddress(s).Bytes(), 32), nil
	case "bool":
		b, ok := v.(bool)
		if !ok {
			return nil, fmt.Errorf("want a bool, got %T", v)
		}
		w := make([]byte, 32)
		if b {
			w[31] = 1
		}
		return w, nil
	case "uint64":
		n, err := toUint64(v)
		if err != nil {
			return nil, err
		}
		return common.LeftPadBytes(new(big.Int).SetUint64(n).Bytes(), 32), nil
	case "bytes32":
		switch x := v.(type) {
		case common.Hash:
			return x.Bytes(), nil
		case []byte:
			if len(x) != 32 {
				return nil, fmt.Errorf("bytes32 of %d bytes", len(x))
			}
			return x, nil
		case string:
			b, err := hexutil.Decode(x)
			if err != nil || len(b) != 32 {
				return nil, fmt.Errorf("bytes32 %q", x)
			}
			return b, nil
		}
		return nil, fmt.Errorf("want bytes32, got %T", v)
	}
	return nil, fmt.Errorf("unsupported EIP-712 type %q", f.Type)
}

func toUint64(v any) (uint64, error) {
	switch x := v.(type) {
	case uint64:
		return x, nil
	case uint32:
		return uint64(x), nil
	case uint:
		return uint64(x), nil
	case int64:
		if x < 0 {
			return 0, fmt.Errorf("negative %d", x)
		}
		return uint64(x), nil
	case int:
		if x < 0 {
			return 0, fmt.Errorf("negative %d", x)
		}
		return uint64(x), nil
	}
	return 0, fmt.Errorf("want an integer, got %T", v)
}

// SignUserSigned signs u.
func SignUserSigned(s Signer, u UserSigned) (Signature, error) {
	d, err := u.Digest()
	if err != nil {
		return Signature{}, err
	}
	return sign(s, d)
}

// ---------------------------------------------------------------- requests

// Request is the /exchange body.
type Request struct {
	Action       any             `json:"action"`
	Nonce        uint64          `json:"nonce"`
	Signature    Signature       `json:"signature"`
	VaultAddress *common.Address `json:"vaultAddress,omitempty"`
	ExpiresAfter *uint64         `json:"expiresAfter,omitempty"`
}

// NewL1Request signs action and returns the request that carries it.
func NewL1Request(s Signer, action any, nonce uint64, o L1Options, mainnet bool) (Request, error) {
	sig, err := SignL1(s, action, nonce, o, mainnet)
	if err != nil {
		return Request{}, err
	}
	return Request{Action: action, Nonce: nonce, Signature: sig, VaultAddress: o.VaultAddress, ExpiresAfter: o.ExpiresAfter}, nil
}

// NewUserSignedRequest signs u and returns the request that carries it.
func NewUserSignedRequest(s Signer, u UserSigned) (Request, error) {
	sig, err := SignUserSigned(s, u)
	if err != nil {
		return Request{}, err
	}
	return Request{Action: u.Action, Nonce: u.Nonce, Signature: sig}, nil
}
