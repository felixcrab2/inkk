# inkk on iPhone

The plan is a Capacitor shell around the existing React app, so the editor, the
telemetry recorder and the canvas book renderer are all reused rather than
rewritten. React Native would mean rebuilding the recorder against a different
event model, which is the one piece worth protecting.

## What is done

The mobile writing surface, in `@media (max-width: 600px)` blocks so the
desktop app is untouched:

- **Keyboard-aware layout.** `visualViewport` publishes `--kb-inset`, and the
  editor sits on top of the keyboard instead of behind it. Gated to coarse
  pointers, because desktop browser zoom also shrinks the visual viewport and
  would otherwise look identical to a keyboard appearing.
- **Typewriter scrolling.** With the keyboard up the caret is held at ~40% of
  the visible strip rather than drifting to the bottom edge, so the line you
  are writing stays where your eyes already are. Desktop keeps its original
  catch-it-near-the-bottom rule.
- **Nothing but the page while writing.** Nav, stats and the signal strip fade
  out; the strip reclaims the full window.
- **Safe areas.** `viewport-fit=cover` plus `env(safe-area-inset-*)` for the
  notch and home indicator.
- **The art.** `cover` crops a plate so hard on a phone that it reads as
  texture, so mobile uses `contain` and the whole engraving stays legible. It
  greets the blank page and leaves once the piece has words, which is the same
  ritual as desktop and lands harder on a small screen.

## What is next

**Xcode is the gate.** It is a ~10GB download and is needed for both the
Simulator and any iOS build.

```bash
# once Xcode.app and CocoaPods are installed:
npm i @capacitor/core @capacitor/cli @capacitor/ios
npx cap init inkk site.inkk.app --web-dir=build
npm run build && npx cap add ios
npx cap run ios --livereload      # iPhone in a window, hot reload
```

Then: App Store distribution (review, 1 to 3 days, unlike the Mac DMG which has
none), App Privacy labels declaring the telemetry, and a real device for the
only thing the Simulator cannot judge, which is whether it actually feels good
to write on.

## Not in v1

iOS sandboxing means no cross-app monitoring, so there is no phone equivalent
of the desktop companion. The unlock is a **custom inkk keyboard**, which iOS
does allow and which sees typing in every app. It also captures touch-down and
touch-up per key, which restores a dwell-like signal that mobile web cannot
reach. That is a product in itself, so it is not first.
