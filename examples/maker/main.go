// Command maker quotes firm held orders on one book: it reads the book's rules, signs one
// post-only order on each side, replaces the book with them, then follows what happens to them
// until interrupted, and withdraws the book on the way out.
//
//	HELD_WALLET_KEY=<hex, from a file> MAKER_ACCOUNT=0x... SKEW_MAKER_KEY=skm_... SKEW_HELD_GRPC=host:443 go run ./examples/maker
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	rfqv1 "github.com/skew-trade/skew-sdk/gen/rfq/v1"
	"github.com/skew-trade/skew-sdk/heldsign"
	"github.com/skew-trade/skew-sdk/makerclient"
)

const book = 4242 // the outcome id

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	key, err := crypto.HexToECDSA(strings.TrimPrefix(os.Getenv("HELD_WALLET_KEY"), "0x")) // an API wallet used for held orders only
	check(err)
	signer, err := heldsign.KeySigner(key)
	check(err)
	account := common.HexToAddress(os.Getenv("MAKER_ACCOUNT")) // the allowlisted Hyperliquid account that trades

	c, err := makerclient.Dial(ctx, makerclient.Options{Target: os.Getenv("SKEW_HELD_GRPC"), Key: os.Getenv("SKEW_MAKER_KEY")})
	check(err)
	defer c.Close()

	rules, err := c.Rules(ctx, book)
	check(err)
	now := uint64(rules.GetServerTime().AsTime().UnixMilli()) // every time is checked against the server's clock
	quotes := []struct {
		side  heldsign.Side
		isBuy bool
		px    string
		size  uint64
	}{
		{heldsign.Yes, true, "0.54", 20}, // buy 20 Yes at 0.54
		{heldsign.No, true, "0.44", 20},  // buy 20 No at 0.44
	}
	var orders []*rfqv1.HeldOrder
	for i, q := range quotes {
		px, err := heldsign.ParsePx(q.px)
		check(err)
		cloid, err := heldsign.NewCloid()
		check(err)
		o, err := makerclient.Sign(signer, heldsign.Draft{
			Account: account, Book: book, Side: q.side, IsBuy: q.isBuy, Px: px, Size: q.size,
			Tif: heldsign.TifAlo, Cloid: cloid,
			Nonce:             now + uint64(2*i), // the clear takes Nonce + 1: every nonce is new
			ExpiresAfter:      now + 60_000,      // Skew may relay the order for a minute
			ClearExpiresAfter: now + 120_000,     // its cancel outlives it
		}, rules) // signed for the network the rules name
		check(err)
		orders = append(orders, o)
	}

	// Replaces ALL of this maker's orders on the book; Seq must grow per book.
	res, err := c.ReplaceBook(ctx, &rfqv1.ReplaceHeldBookOrdersRequest{Book: book, Seq: uint64(time.Now().UnixMilli()), Orders: orders})
	check(err)
	if !res.GetApplied() {
		log.Printf("not applied: %s %s", res.GetCode(), res.GetReason())
	}
	for _, v := range res.GetVerdicts() {
		fmt.Println(v.GetCloid(), v.GetCode(), v.GetReason())
	}

	// Watch reopens a broken stream from the last position it reached; save `at` to resume after
	// a restart (WatchOptions.From).
	err = c.Watch(ctx, makerclient.WatchOptions{Book: book}, func(ev *rfqv1.HeldOrderEvent, at makerclient.Position) error {
		if ev.GetType() == "reset" {
			log.Printf("reset %s: send the book again", ev.GetResetReason())
		}
		for _, o := range ev.GetOrders() {
			fmt.Println(ev.GetType(), o.GetCloid(), o.GetState(), o.GetFilledSz())
		}
		return nil
	})
	check(err)

	// Pull the quotes before leaving (a fresh context: ctx has ended).
	wctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err = c.Withdraw(wctx, book, 0)
	check(err)
}

func check(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
