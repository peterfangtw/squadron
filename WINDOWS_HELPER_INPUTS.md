# Windows helper inputs

Built for Windows x64 with .NET Framework 4.8.1 or later.
These are build inputs for a release; this bundle is not a release-gate receipt.

Extract this ZIP on the Mac. From the intended Squadron checkout, set the
absolute extraction directory and the manifest pins below before running the
normal release command. Do not use --without-windows-helper.
The build verifies the helper sources, compiler, protocol and artifact hashes.
Changed helper sources or recipes require newly matching Windows artifacts.

```sh
export SQUADRON_PRIVATE_FILES_INPUT="/absolute/path/to/windows-helper-inputs"
export SQUADRON_CONSOLE_LOGIN_INPUT="$SQUADRON_PRIVATE_FILES_INPUT"
export SQUADRON_PRIVATE_FILES_INPUT_MANIFEST_SHA256='62a1867485113820fdd6e74a49e08849ae1b008cc19027e35c282dba09c56e67'
export SQUADRON_CONSOLE_LOGIN_INPUT_MANIFEST_SHA256='a38c43ffcda930594b613e93aec0133f49cd353d38f6d343c3029edfd00804ea'
node scripts/private-files-helper.mjs build
node scripts/console-login-helper.mjs build
node scripts/private-files-helper.mjs verify
node scripts/console-login-helper.mjs verify
```

The build subcommands above import the supplied artifacts into dist/helpers.
Normal release/deploy commands also import and verify these inputs.

Run the repository release, smoke, deployment and publication workflow normally.
Do not reuse the existing v0.6.9 package; publishing requires a new version.

Archive: `windows-helper-inputs-2026-11-04.zip`

SHA-256: `a6f0e415257b1a4bb5e3ce42b16e3ad2e638347ac5727263d7e98641946061d6`

Verified on Windows: four focused native checks passed. Both artifacts also passed
source/toolchain verification and an import from the extracted archive. Full
release checks and smoke are still required for the final extension package.
