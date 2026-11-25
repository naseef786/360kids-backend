-- Staging-only Checkout attempts. This private table is not a source of real-money settlement.
CREATE TABLE app.stripe_test_checkouts (
  booking_id uuid PRIMARY KEY REFERENCES app.bookings(id),
  booking_version integer NOT NULL CHECK (booking_version > 0),
  amount_fils integer NOT NULL CHECK (amount_fils > 0),
  session_id text UNIQUE,
  checkout_url text,
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','open','verified','exception')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
REVOKE ALL ON app.stripe_test_checkouts FROM PUBLIC;
