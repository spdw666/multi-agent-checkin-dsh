# WebView2 build inputs

UI release: 0.8.1-web.1. Backend baseline: public 0.8.1 plus portable path defaults.

The optional builder uses host/NativeDesktop.cs (442725 source bytes before Git newline normalization), SHA-256: 8fd33cde0bc8e3904d7f57df3b2161c6e540f694cd8fe4d0f1fb34a0767f137a. This is the source input used by the portable release package. It contains the earlier internal tool helpers but the Web host does not expose native tools.open. The repository's default desktop/AiCreditDesktop.cs and desktop/build.ps1 are unchanged.

Compiler output and ZIP timestamps may differ between builds. Source/SDK/Node/bootstrapper hashes and runtime contracts, rather than a claimed bit-identical build, are the reproducibility boundary. BUILD-MANIFEST.json in a built package records the SDK pin, product versions and portable flag; the exact optional native source hash is documented above.