# StemPlayer Website

Official product and release website for StemPlayer.

The site currently presents:

- **StemPlayer V1** — Free
- **StemPlayer V2** — Available now
- **StemPlayer V3** — Product Preview

## Live website

https://stemplayer-app.netlify.app/

## Included

- `index.html` — responsive StemPlayer product landing page
- `thank-you.html` — V2 post-purchase fulfillment page
- `assets/stemplayer-v2-main.png` — V2 product screenshot
- `assets/stemplayer-v2-demo.mp4` — V2 product demo
- `assets/stemplayer-v3-main.png` — V3 product screenshot
- `assets/Before export.png` — V3 backing-track mix example
- `assets/Render EQ.png` — V3 per-track EQ example
- `assets/Export.png` — V3 WAV export dialog
- `assets/After export.png` — exported backing-track example

## StemPlayer V1

The original free release of StemPlayer.

V1 Free:
https://github.com/bithit2003/StemPlayer/releases/tag/v1.0.0

## StemPlayer V2

V2 expands StemPlayer into a focused Windows practice tool with:

- Quick Presets
- Practice Sessions
- Pitch Shift
- Chord Analysis
- Chord Timeline

### V2 pricing

StemPlayer V2 uses live backend-controlled pricing.

- **Early Bird:** $5 USD one-time for the first 30 customers
- **Regular price:** $9.99 USD one-time
- **Subscription:** No
- **Platform:** Windows

The landing page retrieves the current price and Early Bird
availability from the commerce backend.

The paid V2 installer is not exposed as a public GitHub Release asset.

## StemPlayer V3

### Choose what you play. Export the rest.

V3 extends the StemPlayer workflow from focused practice into
custom backing-track preparation.

V3 adds three core capabilities:

1. **Dynamic Stem Slots**
   - Add additional stems beyond the original fixed track layout.
   - Examples include Back Vocal, Lead Vocal, Lead Guitar,
     Rhythm Guitar, Piano, and other separated parts.

2. **Per-track EQ**
   - Low / Mid / High EQ controls for individual stems.

3. **Export Backing Track**
   - Build a custom stem mix.
   - Export the current mix as a WAV backing track.
   - The Reference track is excluded from the exported mix.

Typical workflow:

**Song → UVR / MVSEP → Stems → StemPlayer V3 → Choose & Mix → Export WAV → Practice / Perform**

StemPlayer does not perform stem separation itself.

### V3 commercial status

V3 is currently presented on the website as a **Product Preview**.

V3 pricing and checkout are not yet public.
Commercial release details will be announced when V3 is ready for sale.

## V2 checkout and fulfillment

The public website is connected to the live V2 PayPal checkout.

Successful V2 purchases follow the protected fulfillment flow:

**PayPal → Capture → License → Protected R2 Download**

The V2 installer is stored privately and delivered through a
short-lived signed download URL.

## Launch policy

- V1 remains free.
- V2 uses live backend-controlled pricing.
- V3 is currently a product preview.
- No subscription.
- Testimonials and public download counters are not shown until
  sufficient real, verified data exists.
- Paid installers are not exposed as public GitHub Release assets.
- Product claims should reflect functionality that exists in the
  released application.

## Feedback

https://github.com/bithit2003/StemPlayer/issues/new