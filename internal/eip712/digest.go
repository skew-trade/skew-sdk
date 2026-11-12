package eip712

import (
	"errors"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// DigestSigner signs a precomputed 32-byte digest and returns r||s||v with v
// in {27, 28}. A key in memory or an MPC/HSM signer
// plugs in behind the same shape.
type DigestSigner interface {
	Address() string
	SignDigest(digest [32]byte) ([]byte, error)
}

// secp256k1n/2: signatures with a higher s are malleable and are refused, as
// OpenZeppelin's ECDSA.recover refuses them on-chain.
var secp256k1HalfN = new(big.Int).Rsh(crypto.S256().Params().N, 1)

// Recover returns the address that produced sig (65 bytes, r||s||v, v in
// {0,1,27,28}) over digest. High-s signatures are refused.
func Recover(digest common.Hash, sig []byte) (common.Address, error) {
	if len(sig) != 65 {
		return common.Address{}, fmt.Errorf("signature is %d bytes, want 65", len(sig))
	}
	s := new(big.Int).SetBytes(sig[32:64])
	if s.Cmp(secp256k1HalfN) > 0 {
		return common.Address{}, errors.New("signature has a high s value (malleable)")
	}
	norm := make([]byte, 65)
	copy(norm, sig)
	switch norm[64] {
	case 27, 28:
		norm[64] -= 27
	case 0, 1:
	default:
		return common.Address{}, fmt.Errorf("signature v=%d is not 0/1/27/28", sig[64])
	}
	pub, err := crypto.SigToPub(digest[:], norm)
	if err != nil {
		return common.Address{}, err
	}
	return crypto.PubkeyToAddress(*pub), nil
}

// SplitSignature returns (v, r, s) for a contract call, with v in {27, 28}.
func SplitSignature(sig []byte) (v uint8, r, s common.Hash, err error) {
	if len(sig) != 65 {
		return 0, r, s, fmt.Errorf("signature is %d bytes, want 65", len(sig))
	}
	v = sig[64]
	if v < 27 {
		v += 27
	}
	copy(r[:], sig[:32])
	copy(s[:], sig[32:64])
	return v, r, s, nil
}
