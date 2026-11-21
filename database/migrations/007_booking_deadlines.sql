-- D05-D06: finite review holds and explicit unresolved-payment exceptions.
ALTER TABLE app.bookings ADD COLUMN review_due_at timestamptz;
ALTER TABLE app.bookings ADD COLUMN payment_started_at timestamptz;

UPDATE app.bookings b SET payment_started_at = (
  SELECT min(a.created_at) FROM app.audit a
  WHERE a.subject_id=b.id AND a.action IN ('accept','accept-offer'))
WHERE b.state IN ('PAYMENT_DUE','PAYMENT_CHECKING','CONFIRMED');

-- Existing PAYMENT_CHECKING records must not keep capacity indefinitely.
UPDATE app.bookings b SET review_due_at = LEAST(
  COALESCE((SELECT p.submitted_at + interval '24 hours' FROM app.payments p WHERE p.booking_id=b.id), now()),
  s.cutoff_at)
FROM app.sessions s WHERE b.session_id=s.id AND b.state='PAYMENT_CHECKING';

CREATE TABLE app.payment_exceptions (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL UNIQUE REFERENCES app.bookings,
  payment_id uuid NOT NULL REFERENCES app.payments,
  reason text NOT NULL CHECK(reason IN ('review_expired')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_review_queue ON app.bookings(state,review_due_at,id)
  WHERE state='PAYMENT_CHECKING';
CREATE TABLE app.booking_reminders (
  booking_id uuid NOT NULL REFERENCES app.bookings,
  kind text NOT NULL CHECK(kind IN ('request','offer','payment','review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(booking_id,kind)
);
REVOKE ALL ON app.booking_reminders FROM PUBLIC;
REVOKE ALL ON app.payment_exceptions FROM PUBLIC;
