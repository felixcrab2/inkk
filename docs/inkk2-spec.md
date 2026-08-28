# INKK2 — the seal

How a piece of writing carries proof that a human wrote it, through email,
files, and messages, without inkk storing the text and usually without anyone
clicking anything.

## Principles

1. **The padlock, not the scanner.** Applied automatically, read passively,
   rarely clicked. Its power comes from being ordinary, and eventually from its
   absence being noticeable. inkk is not a detector and nobody should have to
   paste an essay into a box to use it.
2. **Never store the text.** Only a hash. inkk cannot reconstruct a word of
   anyone's writing, and the strongest form of the seal means inkk is never
   contacted at all.
3. **Quiet, not hidden.** In files the seal is invisible because files have a
   metadata slot for it. In email and messages it is *small* rather than
   concealed. Anything resembling hidden characters in someone's prose is a
   headline waiting to happen for a trust brand.
4. **Minimum disclosure by default.** A verification page says the piece was
   written by hand and when it was certified. Process detail is the writer's to
   reveal, never inkk's to publish.

## The mark

The mark is the wordmark, `inkk.`, set small and quiet. No diamond, no badge
furniture, no shouting. In HTML contexts it is a hyperlink whose visible text is
just `inkk.` and whose `href` carries the whole certificate.

## The token

`INKK2.<base64url(payload‖signature)>` — 124 characters, URL-safe.

| bytes | field | notes |
|---|---|---|
| 0 | version | `0x02` |
| 1 | keyId | selects inkk's signing key; allows rotation |
| 2 | score | 0..100 |
| 3 | tier | 0 Faint · 1 Developing · 2 Strong · 3 Distinct |
| 4..7 | issuedAt | uint32 BE, unix **seconds** |
| 8..23 | hash16 | first 16 bytes of SHA-256 of the normalised text |
| 24..87 | signature | Ed25519 over the 24 payload bytes |

128 bits of content hash is well past what collision resistance needs here, and
truncating is what keeps the token short enough to live in a link.

Verification is: check the signature against inkk's published public key, then
(optionally) hash the text you are holding and compare. **No network, no
lookup, no trust in inkk being alive.** It also means inkk never learns who
verified which document, which matters when the reader is an admissions office.

Implementation: `src/verify/token.js`, tests in `src/verify/token.test.mjs`.
The module is crypto-agnostic (sign/verify injected) so it imports cleanly into
the browser bundle, Electron's main process, and the Vercel function.

## The short code

`INKK-XXXX-XXXX-XXXX`, derived from SHA-256 of the token rather than random, so
the two notations are the same certificate at different resolutions. Same
Crockford alphabet and length as today's codes, so `parseVerifyCode` and the
existing verify page keep working unchanged.

## Carriers

Strongest proof where there is room; lightest touch where there is not.

| channel | carrier | verifies offline |
|---|---|---|
| PDF | XMP metadata + optional footer line | yes |
| DOCX | custom document property | yes |
| HTML email | `<a href="…/v/INKK2.…">inkk.</a>` | yes |
| Plain text, iMessage, Slack | short code + short URL | no, needs lookup |

### HTML email

```html
<a href="https://inkk.site/v/INKK2.AgEB…"
   style="font:400 12px/1.4 'EB Garamond',Georgia,serif;color:#8a8580;
          text-decoration:none">inkk.</a>
```

The reader sees one small word. The certificate rides in the `href`.

## Applying the seal

The writer never runs a separate "certify" step. The companion already knows
what was written, so the seal is applied at the boundary where writing becomes
a document:

- On export, a new PDF or DOCX is matched against live sessions by content and
  stamped in metadata.
- For email, the mark is a one-line signature the app can insert.
- The writer chooses **visible** (the `inkk.` mark) or **invisible** (metadata
  only) per piece.

## Reading the seal

The receiver's app looks only at **what the reader has actively opened** — the
frontmost document, plus a short history of recent ones. It does not index the
disk. Most recent at the top, each with its score, and a detail view offering an
optional paste-the-text check for anyone who wants certainty.

Three states must be visually distinct, because the third is what protects the
brand against someone typing a plausible-looking fake:

- **Sealed** — signature valid
- **No seal** — nothing present
- **Seal does not verify** — present but invalid or altered

## Keys

inkk holds the Ed25519 private key server-side; only `api/certify` signs. The
public key is published and bundled into clients so verification needs no
network. `keyId` supports rotation, and clients carry all historical public keys
so old certificates never expire.

## What this does not claim

It proves *a human wrote this text, and roughly how*. It does not prove the
ideas are original, and it does not prove *which* human. Text composed by a
model and then retyped by hand is the honest limit of the current signal;
separating composition from transcription is what the telemetry corpus and the
learned encoder are for.
