// Package hl builds and signs Hyperliquid L1 actions byte for byte as Hyperliquid hashes them:
// the order and cancel actions with their msgpack and phantom-agent signature, and the
// user-signed EIP-712 actions. It sends nothing; heldsign is what the SDK's clients call.
//
// Every byte that is signed is built here. Getting one wrong recovers a different signer and
// fails SILENTLY (HTTP 200, no effect), so golden_test.go pins the encoders to vectors produced by
// the hyperliquid-python-sdk.
package hl

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
)

// KV is one entry of an ordered map.
type KV struct {
	K string
	V any
}

// OMap is an insertion-ordered map. Hyperliquid hashes the msgpack of an
// action, and the exchange re-serializes the action in its own struct order to
// check the hash, so key order is part of the signature: actions are built as
// OMaps, never Go maps. MarshalJSON keeps the same order.
type OMap []KV

// Pairs builds an OMap from alternating keys and values. It panics on an odd
// count or a non-string key (a programming error).
func Pairs(kv ...any) OMap {
	if len(kv)%2 != 0 {
		panic("hl: Pairs needs key/value pairs")
	}
	m := make(OMap, 0, len(kv)/2)
	for i := 0; i < len(kv); i += 2 {
		k, ok := kv[i].(string)
		if !ok {
			panic(fmt.Sprintf("hl: Pairs key %v is not a string", kv[i]))
		}
		m = append(m, KV{K: k, V: kv[i+1]})
	}
	return m
}

// Get returns the value for k.
func (m OMap) Get(k string) (any, bool) {
	for _, kv := range m {
		if kv.K == k {
			return kv.V, true
		}
	}
	return nil, false
}

// Keys returns the keys in order.
func (m OMap) Keys() []string {
	out := make([]string, len(m))
	for i, kv := range m {
		out[i] = kv.K
	}
	return out
}

// MarshalJSON writes the entries in order.
func (m OMap) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, kv := range m {
		if i > 0 {
			b.WriteByte(',')
		}
		k, err := json.Marshal(kv.K)
		if err != nil {
			return nil, err
		}
		b.Write(k)
		b.WriteByte(':')
		v, err := json.Marshal(kv.V)
		if err != nil {
			return nil, fmt.Errorf("hl: json %q: %w", kv.K, err)
		}
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// Pack encodes v exactly as Python's msgpack.packb does with its defaults
// (use_bin_type=True), which is what Hyperliquid's reference signer hashes:
//   - integers in the smallest form (positive fixint, uint8..uint64, negative
//     fixint, int8..int64);
//   - strings as fixstr / str8 / str16 / str32 by UTF-8 length;
//   - []byte as bin8 / bin16 / bin32;
//   - arrays and ordered maps by element count.
//
// Supported values: nil, bool, string, []byte, every Go integer type, OMap,
// []any, and slices of any supported type. Floats and Go maps are refused: a
// float has no place in a signed action (amounts are decimal strings), and a
// Go map has no order.
func Pack(v any) ([]byte, error) {
	var b bytes.Buffer
	if err := pack(&b, v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func pack(b *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteByte(0xc0)
	case bool:
		if x {
			b.WriteByte(0xc3)
		} else {
			b.WriteByte(0xc2)
		}
	case string:
		packStr(b, x)
	case []byte:
		packBin(b, x)
	case int:
		packInt(b, int64(x))
	case int8:
		packInt(b, int64(x))
	case int16:
		packInt(b, int64(x))
	case int32:
		packInt(b, int64(x))
	case int64:
		packInt(b, x)
	case uint:
		packUint(b, uint64(x))
	case uint8:
		packUint(b, uint64(x))
	case uint16:
		packUint(b, uint64(x))
	case uint32:
		packUint(b, uint64(x))
	case uint64:
		packUint(b, x)
	case OMap:
		packMapHeader(b, len(x))
		for _, kv := range x {
			packStr(b, kv.K)
			if err := pack(b, kv.V); err != nil {
				return fmt.Errorf("%s: %w", kv.K, err)
			}
		}
	case []any:
		packArrayHeader(b, len(x))
		for i, e := range x {
			if err := pack(b, e); err != nil {
				return fmt.Errorf("[%d]: %w", i, err)
			}
		}
	case float32, float64:
		return fmt.Errorf("hl: refusing to msgpack a float (%v): amounts are decimal strings", x)
	default:
		rv := reflect.ValueOf(v)
		switch rv.Kind() {
		case reflect.Slice, reflect.Array:
			packArrayHeader(b, rv.Len())
			for i := 0; i < rv.Len(); i++ {
				if err := pack(b, rv.Index(i).Interface()); err != nil {
					return fmt.Errorf("[%d]: %w", i, err)
				}
			}
		case reflect.Pointer:
			if rv.IsNil() {
				b.WriteByte(0xc0)
				return nil
			}
			return pack(b, rv.Elem().Interface())
		default:
			return fmt.Errorf("hl: cannot msgpack %T (use OMap, []any or a scalar)", v)
		}
	}
	return nil
}

func packUint(b *bytes.Buffer, n uint64) {
	switch {
	case n <= 0x7f:
		b.WriteByte(byte(n))
	case n <= math.MaxUint8:
		b.Write([]byte{0xcc, byte(n)})
	case n <= math.MaxUint16:
		b.WriteByte(0xcd)
		_ = binary.Write(b, binary.BigEndian, uint16(n))
	case n <= math.MaxUint32:
		b.WriteByte(0xce)
		_ = binary.Write(b, binary.BigEndian, uint32(n))
	default:
		b.WriteByte(0xcf)
		_ = binary.Write(b, binary.BigEndian, n)
	}
}

func packInt(b *bytes.Buffer, n int64) {
	switch {
	case n >= 0:
		packUint(b, uint64(n))
	case n >= -32:
		b.WriteByte(byte(n)) // negative fixint 0xe0..0xff
	case n >= math.MinInt8:
		b.Write([]byte{0xd0, byte(n)})
	case n >= math.MinInt16:
		b.WriteByte(0xd1)
		_ = binary.Write(b, binary.BigEndian, int16(n))
	case n >= math.MinInt32:
		b.WriteByte(0xd2)
		_ = binary.Write(b, binary.BigEndian, int32(n))
	default:
		b.WriteByte(0xd3)
		_ = binary.Write(b, binary.BigEndian, n)
	}
}

func packStr(b *bytes.Buffer, s string) {
	n := len(s)
	switch {
	case n < 32:
		b.WriteByte(0xa0 | byte(n))
	case n <= math.MaxUint8:
		b.Write([]byte{0xd9, byte(n)})
	case n <= math.MaxUint16:
		b.WriteByte(0xda)
		_ = binary.Write(b, binary.BigEndian, uint16(n))
	default:
		b.WriteByte(0xdb)
		_ = binary.Write(b, binary.BigEndian, uint32(n))
	}
	b.WriteString(s)
}

func packBin(b *bytes.Buffer, p []byte) {
	n := len(p)
	switch {
	case n <= math.MaxUint8:
		b.Write([]byte{0xc4, byte(n)})
	case n <= math.MaxUint16:
		b.WriteByte(0xc5)
		_ = binary.Write(b, binary.BigEndian, uint16(n))
	default:
		b.WriteByte(0xc6)
		_ = binary.Write(b, binary.BigEndian, uint32(n))
	}
	b.Write(p)
}

func packArrayHeader(b *bytes.Buffer, n int) {
	switch {
	case n < 16:
		b.WriteByte(0x90 | byte(n))
	case n <= math.MaxUint16:
		b.WriteByte(0xdc)
		_ = binary.Write(b, binary.BigEndian, uint16(n))
	default:
		b.WriteByte(0xdd)
		_ = binary.Write(b, binary.BigEndian, uint32(n))
	}
}

func packMapHeader(b *bytes.Buffer, n int) {
	switch {
	case n < 16:
		b.WriteByte(0x80 | byte(n))
	case n <= math.MaxUint16:
		b.WriteByte(0xde)
		_ = binary.Write(b, binary.BigEndian, uint16(n))
	default:
		b.WriteByte(0xdf)
		_ = binary.Write(b, binary.BigEndian, uint32(n))
	}
}

// OMapFromJSON decodes a JSON object into an OMap, keeping the key order of
// the document (nested objects become OMaps, arrays []any, numbers int64 or
// uint64 when integral, else json.Number). It is how a presigned action
// received as JSON is re-hashed without reordering it.
func OMapFromJSON(raw []byte) (OMap, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	v, err := decodeOrdered(dec)
	if err != nil {
		return nil, err
	}
	m, ok := v.(OMap)
	if !ok {
		return nil, fmt.Errorf("hl: JSON is not an object")
	}
	return m, nil
}

func decodeOrdered(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			var m OMap
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, fmt.Errorf("hl: object key %v", kt)
				}
				v, err := decodeOrdered(dec)
				if err != nil {
					return nil, err
				}
				m = append(m, KV{k, v})
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			if m == nil {
				m = OMap{}
			}
			return m, nil
		case '[':
			out := []any{}
			for dec.More() {
				v, err := decodeOrdered(dec)
				if err != nil {
					return nil, err
				}
				out = append(out, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return out, nil
		}
		return nil, fmt.Errorf("hl: unexpected delimiter %v", t)
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return i, nil
		}
		var u uint64
		if _, err := fmt.Sscan(t.String(), &u); err == nil && fmt.Sprint(u) == t.String() {
			return u, nil
		}
		return t, nil
	default:
		return t, nil // string, bool, nil
	}
}
