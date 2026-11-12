package hip4

import "errors"

// ---------------------------------------------------------------- violations

// Rule names the rule an order breaks.
type Rule string

const (
	RuleTick      Rule = "tick"       // a price off the 0.00001 tick
	RuleSize      Rule = "size"       // a size that is not a positive whole number of shares
	RulePrice     Rule = "price"      // a price not strictly between 0 and 1
	RuleValue     Rule = "value"      // an order worth under 1 USDC on its own value
	RuleUserValue Rule = "user_value" // an order under 1 USDC on its own value (size x limit), as CheckValue says it
)

// Violation is a broken rule.
type Violation struct {
	Rule   Rule
	Detail string
}

func (v *Violation) Error() string { return "hip4: " + string(v.Rule) + ": " + v.Detail }

// AsViolation finds a Violation in err's chain.
func AsViolation(err error) (*Violation, bool) {
	var v *Violation
	if errors.As(err, &v) {
		return v, true
	}
	return nil, false
}
