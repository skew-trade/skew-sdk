// Package eip712 hashes EIP-712 typed data word by word (every member a static type: one
// left-padded 32-byte word per member): a domain's separator, the digest a signature covers
// (TypedDataHash) and the recovery of its signer with low-s enforced (Recover). It also has
// EIP-3009's ReceiveWithAuthorization in HyperEVM USDC's ("USDC", "2") domain.
package eip712

import (
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// Domain is an EIP-712 domain with all four standard fields.
type Domain struct {
	Name              string
	Version           string
	ChainID           *big.Int
	VerifyingContract common.Address
}

// The type strings.
const (
	// DomainType is the full four-field EIP712Domain.
	DomainType = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"

	// ReceiveWithAuthorizationType is Circle's EIP-3009 receive type.
	ReceiveWithAuthorizationType = "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
)

var (
	DomainTypeHash                   = crypto.Keccak256Hash([]byte(DomainType))
	ReceiveWithAuthorizationTypeHash = crypto.Keccak256Hash([]byte(ReceiveWithAuthorizationType))
)

// Separator is keccak256(abi.encode(DOMAIN_TYPEHASH, keccak(name), keccak(version), chainId, verifyingContract)).
func (d Domain) Separator() common.Hash {
	if d.ChainID == nil {
		panic("eip712: domain without a chain id")
	}
	return crypto.Keccak256Hash(
		DomainTypeHash[:],
		crypto.Keccak256([]byte(d.Name)),
		crypto.Keccak256([]byte(d.Version)),
		wordBig(d.ChainID),
		wordAddress(d.VerifyingContract),
	)
}

// TypedDataHash is keccak256("\x19\x01" || separator || structHash).
func TypedDataHash(separator, structHash common.Hash) common.Hash {
	return crypto.Keccak256Hash([]byte{0x19, 0x01}, separator[:], structHash[:])
}

// USDCDomainName and USDCDomainVersion are HyperEVM USDC's EIP-712 domain on
// mainnet (999) and testnet (998): ("USDC", "2"), not Circle's usual
// ("USD Coin", "2").
const (
	USDCDomainName    = "USDC"
	USDCDomainVersion = "2"
)

// USDCDomain is HyperEVM USDC's domain: ("USDC", "2", chainId, usdc).
func USDCDomain(chainID *big.Int, usdc common.Address) Domain {
	return Domain{Name: USDCDomainName, Version: USDCDomainVersion, ChainID: chainID, VerifyingContract: usdc}
}

// Authorization is an EIP-3009 ReceiveWithAuthorization, as the user signs it
// in the USDC domain. Value is micro-USDC.
type Authorization struct {
	From        common.Address `json:"from"`
	To          common.Address `json:"to"`
	Value       *big.Int       `json:"value"`
	ValidAfter  *big.Int       `json:"validAfter"`
	ValidBefore *big.Int       `json:"validBefore"`
	Nonce       common.Hash    `json:"nonce"`
}

// StructHash is hashStruct(ReceiveWithAuthorization).
func (a Authorization) StructHash() common.Hash {
	return crypto.Keccak256Hash(
		ReceiveWithAuthorizationTypeHash[:],
		wordAddress(a.From),
		wordAddress(a.To),
		wordBig(a.Value),
		wordBig(a.ValidAfter),
		wordBig(a.ValidBefore),
		a.Nonce[:],
	)
}

// Digest is the EIP-712 digest under the USDC domain.
func (a Authorization) Digest(usdc Domain) common.Hash {
	return TypedDataHash(usdc.Separator(), a.StructHash())
}

func wordBig(v *big.Int) []byte {
	if v == nil {
		v = new(big.Int)
	}
	if v.Sign() < 0 || v.BitLen() > 256 {
		panic(fmt.Sprintf("eip712: %s does not fit a uint256", v))
	}
	return common.LeftPadBytes(v.Bytes(), 32)
}

func wordAddress(a common.Address) []byte { return common.LeftPadBytes(a[:], 32) }
