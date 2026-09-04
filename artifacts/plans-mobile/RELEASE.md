# Plans Mobile releases

Plans Mobile uses the stable application identifier `com.fieldplans.mobile` on
Android and Apple platforms. Version `1.0.0` starts at Android version code `1`
and iOS build number `1`. Increase the public version for user-visible releases,
and increase both platform build numbers before uploading a replacement build.
Do not change the application identifiers after store records or installed data
exist.

## Before building

1. Set `EXPO_PUBLIC_DOMAIN` in each named Expo build environment to its HTTPS
   API host, without credentials or a path. The profiles select `development`,
   `preview`, or `production`; the production environment must contain the
   published API host. A development-domain value is suitable only for test
   builds. The release check fails rather than bundle `https://undefined`.
2. Run `pnpm --filter @workspace/plans-mobile run check:release-build`. This
   checks native metadata, types, tests, and exports minified Android and iOS
   production bundles, including the embedded PDF.js viewer assets.
3. Keep Android keystores, Apple certificates, provisioning profiles, and store
   credentials in the build provider's credential store. They are ignored by
   git and must not be committed.

## Build profiles

`eas.json` contains the portable build settings used by Expo-compatible build
infrastructure:

- `development`: internally distributed Android APK for development testing.
- `internal`: installable Android APK and a provisioned iOS internal archive.
- `ios-simulator`: unsigned simulator build; it cannot be installed on a device.
- `store`: Android AAB for Google Play and an App Store-ready iOS archive.

On Replit, use **Preview on your phone** for Expo Go development and **Publish**
for the supported iOS App Store build/submission flow. The profiles also make
the intended Android and Apple artifact types explicit for a release operator.
Replit does not currently submit Android builds to Google Play.

## Installation and distribution

- **Android APK:** install the `internal` artifact directly after allowing the
  chosen browser or file manager to install unknown apps. Distribute only APKs
  signed by the same long-lived release key.
- **Google Play:** upload the signed AAB from `store` in Play Console. A Play
  developer account, signing setup, listing, and review are separate.
- **iPhone/iPad internal:** device installation requires a valid Apple
  provisioning profile. Ad hoc distribution only works for registered devices;
  enterprise distribution requires an eligible Apple Enterprise account.
  TestFlight is the normal Apple-approved beta channel.
- **App Store:** use the `store` configuration through Replit's iOS Publish
  flow. A paid Apple Developer membership, App Store Connect record, signing,
  listing, privacy answers, and review are still required.

General public iOS sideloading is not available. Public installation must use an
Apple-approved channel and comply with the channel's account, provisioning, and
device eligibility rules.

## Release smoke check

On at least one Android device and one iPhone/iPad:

1. Open a local PDF from the system picker (and from “Open in” where offered).
2. Set a page scale and add a measurement.
3. Disable networking, add another measurement, force-close, and reopen.
4. Confirm the PDF, cached markings, pending measurement, and pending scale are
   still present.
5. Restore networking and confirm pending work synchronizes.

Imported PDFs live in the app document directory. Document metadata, cached
measurements, retry entries, and pending page scales use persistent
AsyncStorage. Production bundles include both PDF.js files as Metro assets, so
opening a saved plan does not depend on downloading the viewer runtime.
Android uses the system document picker and therefore does not request legacy
storage access. Location and microphone permissions are explicitly blocked
because Plans Mobile does not use those capabilities.