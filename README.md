# web-firmware-installer-js

Web Installation Tool for Firmware for Espressif ESP-based devices. The base installer is intended
to be a general installer for different firmwares with specific application installers building
upon the base installer.

## Specific Installers

`cpinstaller.js` is the installation tool for CircuitPython

## Optional: Flash verification (MD5)

For ESP-family boards, the installer asks `esptool-js` to verify each
flashed image by reading the chip's flash back and comparing its MD5 to
the MD5 of the bytes we wrote. esptool-js only performs that check when
the host page supplies a hashing function, so the installer looks for a
`CryptoJS` global at runtime.

If `CryptoJS` is loaded on the page, verification runs automatically. If
it's missing, the installer silently skips verification (preserving the
previous behavior), which means flash corruption on flaky USB-serial
bridges (notably Pi 5 + CP2104, see issue #22) may go undetected.

To enable verification, include CryptoJS before loading the installer,
for example via CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/crypto-js@4.2.0/crypto-js.min.js"></script>
```

or bundled from npm:

```bash
npm install crypto-js
```

No additional code is required &mdash; the installer detects the global
and uses it automatically.

