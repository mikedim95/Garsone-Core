# Table visits and bills

The customer menu groups successive order rounds into the table's current visit.
Customers can see its total, recorded payments and remaining balance, and request
the bill. The request appears in the staff **Table bills** screen at `/staff/bills`.
Waiters, hybrid staff, managers and architects can manage bills; kitchen-only
accounts cannot record payments.

## Staff flow

1. Open the table's bill. Confirm the current balance and items.
2. Select **Record payment**, then the full balance, a partial amount, or item
   quantities. Select cash or card and record the amount actually received.
3. Repeat for further payments or order rounds. Item selection uses the remaining
   unpaid value; earlier partial credits reduce the amount shown for those items.
4. Close the visit once its balance is zero and its orders are served or cancelled.
   A paid order keeps its kitchen status; recording money does not mark food served.

**Card records money received through a separate terminal. This screen does not
charge a card, contact a payment provider, or issue a fiscal receipt.** Payment
records are immutable in this release; refunds and payment corrections need a
separate audited workflow before they can be offered in the app.

An open visit can move to an available table in the same venue. Its orders,
payments and customer access move together. Occupied tables cannot be merged by
this action. Open visits prevent table deactivation; referenced billing history
is retained when tables are managed.

Existing Noor orders are not automatically assigned to newly arriving guests.
Staff can review older orders and explicitly add selected unpaid orders to a
visit. Previously marked-paid orders remain historical records and do not become
new payment receipts.

## Lost connections and privacy

The browser saves a payment request ID and its exact payload before sending it.
If the response is lost, it checks that ID without recording another payment.
An explicit retry sends the same request. PostgreSQL serializes changes to each
visit and rejects stale revisions and overpayment. If browser storage is
unavailable, payment submission is blocked rather than losing recovery data.

Each customer browser stores an opaque visit capability. Order reads, changes,
bill requests and private realtime updates require that capability. Closing the
visit invalidates it and disconnects its guest sockets. The browser keeps an
ended-visit marker so reload or reconnect cannot silently join the next party.
Starting another visit requires an explicit customer action.

The printed QR still identifies a table. Someone opening that QR afresh can join
its current visit; the capability prevents old-session reuse and cross-visit
access, but does not prove physical presence. Existing cloud locality approval
continues to protect cloud order submission. Local operation relies on venue
network access. Keep the Pi reachable only through the intended local network.

Cloud push subscriptions are limited to a specific order in the active visit.
Old table-wide subscriptions receive no further order notifications. The local
Pi uses same-origin HTTP and WebSockets and needs no cloud push or payment service.

## Reporting and upgrades

Manager economics separates sales value, recorded collections, and the balance
of all current open visits. Sales use order creation time; collections use the
payment recording time. Outstanding balance is a current snapshot, independent
of the selected historical date range. Older orders merely marked paid are
shown separately from collected money. Existing served-order charts describe
operational order value and are labelled accordingly.

Ship Core and Front together: older clients do not supply the visit capability.
The schema upgrade adds visit and payment tables plus a nullable visit reference
on existing orders; it does not reassign historical orders. The deployment's
usual backup step must complete before applying the updated images. Restore a
previous backup into fresh volumes if reverting an incompatible release.

Validation uses a disposable, loopback-only PostgreSQL database and synthetic
browser fixtures. From Core, generate Prisma and build, then run
`node tests/run-order-reliability.mjs`. See the Front `tests/README.md` for the
customer, staff and manager browser suites. These checks do not write to Noor's
prepared snapshot or to a remote venue.
