# What is new in this version

## 1. Home page fixes
- The empty areas on the home page banner are gone. The photo slideshow now fills the whole right side (it was a layout bug: an empty decorative layer was taking up a grid cell).
- The headline words ("budget", "commute", ...) now type about twice as slowly and pause on each word.

## 2. Pesapal payments
Set these environment variables (Render > Environment), then redeploy:

| Variable | Value |
|---|---|
| `PESAPAL_CONSUMER_KEY`, `PESAPAL_CONSUMER_SECRET` | from your Pesapal account (sandbox keys from developer.pesapal.com while testing) |
| `PESAPAL_ENV` | `sandbox` while testing, `live` for real payments |
| `APP_URL` | the public address of your site, e.g. `https://yoursite.onrender.com` |

The payment notification (IPN) address is registered with Pesapal automatically the first time someone pays. Paying sends the user to Pesapal (M-Pesa, card or bank) and back to your site. Every payment is double-checked with Pesapal before anything is unlocked, and replayed notifications cannot give credit twice.

## 3. Admin dashboard > Payments
- **Switches per role.** Tenants: payments on/off, pay to see contact and directions, pay to send suggestions. Landlords: payments on/off, pay to see tenant suggestions, paid boosts. Everything is **free until you switch it on**, and posting a house is always free.
- **Plans and prices.** Add, edit, turn off or delete plans: house view plans (price and how many houses), suggestion subscriptions (price and days) and boosts (price, days, and which of: pin to top, Featured badge, homepage, popular areas). The prices already in there are examples. Change them.
- **Recent payments** and total, and revenue in the analytics panel.
- Admin can **grant a boost free** with the Grant boost button on any listing.

## 4. How it works for users
- **Tenants / visitors** see every house, photos, price and approximate area. Contact and exact directions are locked. Tapping Unlock asks them to log in, then to buy a plan, and each unlocked house stays unlocked. After paying, the house they wanted unlocks automatically.
- **Boosts** (landlord: My listings > Boost): pinned houses appear at the top of results, Featured badge and highlight on the card, a Featured homes section on the home page, and a "Popular right now" section under Popular areas.
- **Suggestions** (the Request a property form): when switched on, tenants need a subscription to send them and landlords need a subscription to see them. Admin always sees them.

## 5. Airbnb-style stays: booking and search
- Landlords choose **Monthly rent** or **Short stay (per night)** when posting, with max guests and an optional **Instant book**.
- Browse has All / Monthly rentals / Short stays. For stays, search by **check-in, check-out and guests**: houses already booked for those dates drop out of the results.
- On a stay, guests pick dates, see the total (nights x price), and book. Instant book confirms at once, otherwise the host confirms or declines. Double bookings are blocked.
- **My trips** (tenants) and **Bookings** (landlords and admin) show requests with Confirm, Decline and Cancel. A confirmed guest sees the host's contact.
- The stay itself is paid directly to the host. Pesapal covers your platform plans only.

## 6. Updating your site
1. Copy these files over your project (the `.git` folder is not included, so your history stays as it is).
2. Add the Pesapal environment variables above. Your Neon database updates itself on the next start (new tables and columns are added; nothing is deleted).
3. Commit, push, and Render redeploys. Log in as admin > Payments to set prices and switch things on.
4. Test in the sandbox first (`PESAPAL_ENV=sandbox`) before going live.

`render.yaml` no longer creates a Render database, since you use Neon. If a free Render database from the earlier setup still exists, you can delete it.
