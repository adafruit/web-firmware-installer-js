// SPDX-FileCopyrightText: 2023 Melissa LeBlanc-Williams for Adafruit Industries
//
// SPDX-License-Identifier: MIT

'use strict';
import { html } from 'https://cdn.jsdelivr.net/npm/lit-html/+esm';
import { map } from 'https://cdn.jsdelivr.net/npm/lit-html/directives/map/+esm';
import * as toml from "https://cdn.jsdelivr.net/npm/iarna-toml-esm@3.0.5/+esm"
import * as zip from "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.6.65/+esm";
import { REPL } from 'https://cdn.jsdelivr.net/gh/adafruit/circuitpython-repl-js@3.2.1/repl.js';
import { InstallButton, ESP_ROM_BAUD, NotRomBootloaderError } from "./base_installer.js";

// TODO: Combine multiple steps together. For now it was easier to make them separate,
// but for ease of configuration, it would be work better to combine them together.
// For instance stepSelectBootDrive and stepCopyUf2 should always be together and in
// that order, but due to having handlers in the first of those steps, it was easier to
// just call nextStep() from the handler.
//
// TODO: Hide the log and make it accessible via the menu (future feature, output to console for now)
// May need to deal with the fact that the ESPTool uses Web Serial and CircuitPython REPL uses Web Serial
//
// TODO: Update File Operations to take advantage of the REPL FileOps class to allow non-CIRCUITPY drive access

const PREFERRED_BAUDRATE = 921600;
const COPY_CHUNK_SIZE = 64 * 1024; // 64 KB Chunks
const DEFAULT_RELEASE_LATEST = false;   // Use the latest release or the stable release if not specified
const BOARD_DEFS = "https://adafruit-circuit-python.s3.amazonaws.com/esp32_boards.json";

const CSS_DIALOG_CLASS = "cp-installer-dialog";

const attrMap = {
    "bootloader": "bootloaderUrl",
    "uf2file": "uf2FileUrl",
    "binfile": "binFileUrl"
}

export class CPInstallButton extends InstallButton {
    constructor() {
        super();
        this.releaseVersion = "[version]";
        this.boardName = "ESP32-based device";
        this.boardIds = null;
        this.selectedBoardId = null;
        this.bootloaderUrl = null;
        this.boardDefs = null;
        this.uf2FileUrl = null;
        this.binFileUrl = null;
        this.releaseVersion = 0;
        this.chipFamily = null;
        this.dialogCssClass = CSS_DIALOG_CLASS;
        this.dialogs = { ...this.dialogs,  ...this.cpDialogs };
        this.bootDriveHandle = null;
        this.circuitpyDriveHandle = null;
        this._bootDriveName = null;
        this._serialPortName = null;
        this.replSerialDevice = null;
        this.repl = null;
        this.fileCache = [];
        this.reader = null;
        this.writer = null;
        this.tomlSettings = null;
        this.init();
    }

    static get observedAttributes() {
        return Object.keys(attrMap);
    }

    parseVersion(version) {
        const versionRegex = /(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?/;
        const versionInfo = {};
        let matches = version.match(versionRegex);
        if (matches && matches.length >= 4) {
            versionInfo.major = matches[1];
            versionInfo.minor = matches[2];
            versionInfo.patch = matches[3];
            if (matches[4] && matches[5]) {
                versionInfo.suffix = matches[4];
                versionInfo.suffixVersion = matches[5];
            } else {
                versionInfo.suffix = "stable";
                versionInfo.suffixVersion = 0;
            }
        }
        return versionInfo;
    }

    sortReleases(releases) {
        // Return a sorted list of releases by parsed version number
        const sortHieratchy = ["major", "minor", "patch", "suffix", "suffixVersion"];
        releases.sort((a, b) => {
            const aVersionInfo = this.parseVersion(a.version);
            const bVersionInfo = this.parseVersion(b.version);
            for (let sortKey of sortHieratchy) {
                if (aVersionInfo[sortKey] < bVersionInfo[sortKey]) {
                    return -1;
                } else if (aVersionInfo[sortKey] > bVersionInfo[sortKey]) {
                    return 1;
                }
            }
            return 0;
        });

        return releases;
    }

    async connectedCallback() {
        // Load the Board Definitions before the button is ever clicked
        const response = await fetch(BOARD_DEFS);
        this.boardDefs = await response.json();

        let boardIds = this.getAttribute("boardid")
        if (!boardIds || boardIds.trim().length === 0) {
            this.boardIds = Object.keys(this.boardDefs);
        } else {
            this.boardIds = boardIds.split(",");
        }

        // If there is only one board id, then select it by default
        if (this.boardIds.length === 1) {
            this.selectedBoardId = this.boardIds[0];
        }

        // If not provided, it will use the stable release if DEFAULT_RELEASE_LATEST is false
        if (this.getAttribute("version")) {
            this.releaseVersion = this.getAttribute("version");
        }

        super.connectedCallback();
    }

    async loadBoard(boardId) {
       // Pull in the info from the json as the default values. These can be overwritten by the attributes.
       let releaseInfo = null;

       if (Object.keys(this.boardDefs).includes(boardId)) {
           const boardDef = this.boardDefs[boardId];
           this.chipFamily = boardDef.chipfamily;
           if (boardDef.name) {
               this.boardName = boardDef.name;
           }
           if (boardDef.bootloader) {
               this.bootloaderUrl = this.updateBinaryUrl(boardDef.bootloader);
           }
           const sortedReleases = this.sortReleases(boardDef.releases);

           if (this.releaseVersion) {  // User specified a release
               for (let release of sortedReleases) {
                   if (release.version == this.releaseVersion) {
                       releaseInfo = release;
                       break;
                   }
               }
           }

           if (!releaseInfo) { // Release version not found or not specified
               if (DEFAULT_RELEASE_LATEST) {
                   releaseInfo = sortedReleases[sortedReleases.length - 1];
               } else {
                   releaseInfo = sortedReleases[0];
               }
               this.releaseVersion = releaseInfo.version;
           }
           if (releaseInfo.uf2file && !this.uf2FileUrl) {
               this.uf2FileUrl = this.updateBinaryUrl(releaseInfo.uf2file);
           }
           if (releaseInfo.binfile && !this.binFileUrl) {
               this.binFileUrl = this.updateBinaryUrl(releaseInfo.binfile);
           }
       }

       // Nice to have for now
       if (this.getAttribute("chipfamily")) {
           this.chipFamily = this.getAttribute("chipfamily");
       }

       if (this.getAttribute("boardname")) {
           this.boardName = this.getAttribute("boardname");
       }
       this.menuTitle = `CircuitPython Installer for ${this.boardName}`;
    }

    attributeChangedCallback(attribute, previousValue, currentValue) {
        const classVar = attrMap[attribute];
        this[classVar] = currentValue ? this.updateBinaryUrl(currentValue) : null;
    }

    updateBinaryUrl(url) {
        //if (location.hostname == "localhost") {
            if (url) {
                url = url.replace("https://downloads.circuitpython.org/", "https://adafruit-circuit-python.s3.amazonaws.com/");
            }
        //}

        return url;
    }

    // These are a series of the valid steps that should be part of a program flow
    // Some steps currently need to be grouped together
    flows = {
        uf2FullProgram: {  // Native USB Install
            label: `Full CircuitPython [version] Install`,
            // stepFsapiCheck sits right after the welcome dialog so the
            // user sees the normal welcome first, then immediately gets
            // the "your browser can't finish automatically" dialog if
            // they're on Firefox. The "Continue Manually" path swaps
            // the drive-picker tail of this flow for the manual
            // variants via continueManuallyHandler. (Issue #24)
            steps: [this.stepWelcome, this.stepFsapiCheck, this.stepSerialConnect, this.stepConfirm, this.stepEraseAll, this.stepBootloader, this.stepSelectBootDrive, this.stepCopyUf2, this.stepSelectCpyDrive, this.stepCredentials, this.stepSuccess],
            isEnabled: async () => { return this.hasNativeUsb() && !!this.bootloaderUrl && !!this.uf2FileUrl },
        },
        binFullProgram: {  // Non-native USB Install (Once we have boot drive disable working, we can remove hasNativeUsb() check)
            label: `Full CircuitPython [version] Install`,
            steps: [this.stepWelcome, this.stepSerialConnect, this.stepConfirm, this.stepEraseAll, this.stepFlashBin, this.stepSetupRepl, this.stepCredentials, this.stepSuccess],
            isEnabled: async () => { return !this.hasNativeUsb() && !!this.binFileUrl },
        },
        uf2Only: { // Upgrade when Bootloader is already installer
            label: `Install CircuitPython [version] UF2 Only`,
            steps: [this.stepWelcome, this.stepSelectBootDrive, this.stepCopyUf2, this.stepSelectCpyDrive, this.stepCredentials, this.stepSuccess],
            // Every step in this flow needs the File System Access API:
            // we never flash anything ourselves, we just pick the BOOT
            // drive, copy the UF2 onto it, then pick CIRCUITPY and write
            // settings.toml. With no FSAPI there's literally nothing the
            // installer can do, so hide the flow on Firefox rather than
            // present a button that opens a dialog and silently fails.
            // (Issue #24)
            isEnabled: async () => { return this.hasNativeUsb() && !!this.uf2FileUrl && this.hasFileSystemAccess },
        },
        binOnly: {
            label: `Install CircuitPython [version] Bin Only`,
            steps: [this.stepWelcome, this.stepSerialConnect, this.stepConfirm, this.stepEraseAll, this.stepFlashBin, this.stepSuccess],
            isEnabled: async () => { return !!this.binFileUrl },
        },
        bootloaderOnly: { // Used to allow UF2 Upgrade/Install
            label: "Install Bootloader Only",
            steps: [this.stepWelcome, this.stepSerialConnect, this.stepConfirm, this.stepEraseAll, this.stepBootloader, this.stepSuccess],
            isEnabled: async () => { return this.hasNativeUsb() && !!this.bootloaderUrl },
        },
        credentialsOnlyRepl: { // Update via REPL
            label: "Update WiFi credentials",
            steps: [this.stepWelcome, this.stepSetupRepl, this.stepCredentials, this.stepSuccess],
            isEnabled: async () => { return !this.hasNativeUsb() },
        },
        credentialsOnlyDrive: { // Update via CIRCUITPY Drive
            label: "Update WiFi credentials",
            steps: [this.stepWelcome, this.stepSelectCpyDrive, this.stepCredentials, this.stepSuccess],
            // Drive-based credential update needs to pick the CIRCUITPY
            // drive and write settings.toml. With no FSAPI we can't do
            // either, so hide on Firefox. Native-USB users on Firefox
            // hit the no-flows menu state; non-native-USB users still
            // get credentialsOnlyRepl (which talks over Web Serial and
            // doesn't need FSAPI at all). (Issue #24)
            isEnabled: async () => { return this.hasNativeUsb() && this.hasFileSystemAccess },
        }
    }

    // This is the data for the CircuitPython specific dialogs. Some are reused.
    cpDialogs = {
        boardSelect: {
            closeable: true,
            template: (data) => html`
                <p>
                    There are multiple boards are available. Select the board you have:
                </p>
                <p>
                    <select id="availableBoards">
                        <option value="0"> - boards - </option>
                        ${map(data.boards, (board, index) => html`<option value="${board.id}" ${board.id == data.default ? "selected" : ""}>${board.name}</option>`)}
                    </select>
                </p>
            `,
            buttons: [{
                label: "Select Board",
                onClick: this.selectBoardHandler,
                isEnabled: async () => { return this.currentDialogElement.querySelector("#availableBoards").value != "0" },
            }],
        },
        welcome: {
            closeable: true,
            template: (data) => html`
                <h3>Web Firmware Installer</h3>
                <p>
                    Welcome!
                    This tool will install a UF2 bootloader and/or CircuitPython on your ${data.boardName}.
                </p>
                <p>
                    This tool is <strong>experimental</strong>.
                    If you experience any issues, feel free to check out
                    <a href="https://github.com/adafruit/circuitpython-org/issues">https://github.com/adafruit/circuitpython-org/issues</a>
                    to see if the issue you are experiencing has already been reported.
                    If not, feel free to open a new issue.
                    If you do see the same issue and are able to contribute additional information,
                    that would be appreciated.
                </p>
                <p>
                    If you are unable to use this tool,
                    then the manual installation methods like the
                    <a href="https://adafruit.github.io/Adafruit_WebSerial_ESPTool/">Adafruit WebSerial Tool</a>
                    and esptool.py should still work.
                </p>
            `
        },
        espSerialConnect: {
            closeable: true,
            template: (data) => html`
                <h3>
                    Connect to Your Board
                </h3>
                <ol>
                    <li>
                        <p>
                            Plug your board into this computer.
                            <em>Make sure the USB cable is good for data sync, and is not a charge-only cable.</em>
                        </p>
                    </li>
                    <li>
                        <p>
                            <strong>Put your board into ROM bootloader mode</strong>,
                            by holding down the BOOT button (sometimes marked "B0"),
                            and clicking the RESET button (sometimes marked "RST").
                            If your board doesn't have a BOOT button, just press RESET.
                        </p>
                    </li>
                    <li>
                        <p>
                            <button id="butConnect" type="button" @click=${this.espToolConnectHandler.bind(this)}>Connect</button>
                            Click this button to open the Web Serial connection menu and choose the serial port for this board.
                        </p>
                        <p>
                            There may be many devices listed, such as your remembered Bluetooth peripherals, anything else plugged into USB, etc.
                            If you aren't sure which to choose, look for words like "USB", "UART", "JTAG", and "Bridge Controller".
                            There may be more than one right option depending on your system configuration. Experiment if needed.
                        </p>
                    </li>
                </ul>
            `,
            buttons: [this.previousButton, {
                label: "Next",
                onClick: this.nextStep,
                isEnabled: async () => { return (this.currentStep < this.currentFlow.steps.length - 1) && this.connected == this.connectionStates.CONNECTED },
                onUpdate: async (e) => { this.currentDialogElement.querySelector("#butConnect").innerText = this.connected; },
            }],
        },
        // Shown when the user picks a serial port that's clearly not
        // an ESP32 ROM bootloader (e.g. TinyUF2 CDC, a running
        // CircuitPython console). This is a user-recoverable hiccup,
        // not an install failure -- they just need to put the board
        // into ROM bootloader mode and try again -- so we show a
        // dialog with a single Continue button that drops them back
        // on the serial-connect dialog of whichever flow they're in.
        // (Issue #20 / #24)
        notRomBootloader: {
            closeable: true,
            template: (data) => html`
                <h3>Not in ROM Bootloader mode</h3>
                ${(data && data.message ? data.message.split("\n\n") : [])
                    .filter((p) => p.trim().length > 0)
                    .map((p) => html`<p>${p}</p>`)}
            `,
            buttons: [{
                label: "OK",
                onClick: async (e) => {
                    this.closeDialog();
                    // Re-run whatever step we're currently sitting on
                    // (which is the flow's serial-connect step). This
                    // re-shows the Connect to Your Board dialog so
                    // the user can pick the right port this time.
                    if (this.currentFlow && typeof this.currentFlow.steps[this.currentStep] === "function") {
                        await this.currentFlow.steps[this.currentStep].bind(this)();
                    }
                },
            }],
        },
        confirm: {
            template: (data) => html`
                <h3>Erase Flash</h3>
                <p>Now, optionally, erase everything on the ${data.boardName}.</p>
            `,
            buttons: [
                this.previousButton,
                {
                    label: "Skip Erase",
                    onClick: async (e) => { if (confirm("Skipping the erase step may cause issues and is not recommended. Continue?")) { await this.advanceSteps(2); }},
                },
                {
                    label: "Continue",
                    onClick: this.nextStep,
                }
            ],
        },
        // Shown by stepWelcome (in place of the normal welcome dialog)
        // when the browser doesn't expose window.showDirectoryPicker
        // (currently Firefox on every platform). User picks between
        // switching browsers for the automated path, or staying on
        // Firefox and copying the UF2 manually via
        // continueManuallyHandler. Shown up front so the user finds out
        // BEFORE clicking through Erase + Bootloader. (Issue #24)
        fsapiUnavailable: {
            closeable: true,
            template: (data) => html`
                <h3>Your browser can't finish automatically</h3>
                <p>
                    Your browser doesn't support the
                    <strong>FileSystem API</strong>, which this installer
                    normally uses to copy the CircuitPython UF2 file onto
                    your board's bootloader drive and to write your WiFi
                    settings to <code>settings.toml</code>.
                </p>
                <p>You have a few options:</p>
                <ul>
                    <li>
                        <strong>Use another browser.</strong>
                        Close this dialog, then re-open this page in
                        Chrome, Edge, or Opera (version 89 or newer).
                        Those browsers support the FileSystem API and
                        will copy CircuitPython and set up WiFi for you
                        automatically.
                    </li>
                    <li>
                        <strong>Continue here and copy manually.</strong>
                        We'll guide you through downloading the
                        CircuitPython UF2 file and dragging it onto your
                        board's bootloader drive yourself. WiFi setup
                        can't be automated this way, but we'll show you
                        how to edit <code>settings.toml</code> by hand
                        once your board is running CircuitPython.
                    </li>
                    ${data && data.binAvailable ? html`
                    <li>
                        <strong>Install the .bin instead.</strong>
                        We can flash CircuitPython directly over USB
                        without using the FileSystem API at all.
                        <em>However</em>, this skips installing the UF2
                        bootloader, so you won't have the drag-and-drop
                        BOOT drive for future firmware updates &mdash;
                        you'll need to come back here (or use a browser
                        with the FileSystem API) every time you want to
                        change CircuitPython versions.
                    </li>
                    ` : html``}
                </ul>
            `,
            buttons: [{
                label: "Use Another Browser",
                onClick: async (e) => {
                    this.closeDialog();
                },
            }, {
                label: "Install .bin Instead",
                onClick: this.installBinInsteadHandler,
                // Show whenever a .bin firmware file is configured for
                // this board. We deliberately bypass
                // binFullProgram.isEnabled() (which gates on
                // !hasNativeUsb()) because this dialog is the user's
                // informed-consent escape hatch: they understand the
                // tradeoff (no UF2 bootloader) and want to flash
                // CircuitPython anyway. The menu still uses
                // isEnabled() so this option stays hidden from normal
                // browsing. Display set via onUpdate because
                // base_installer's isEnabled hook only toggles
                // .disabled and we want the button gone, not greyed.
                onUpdate: async (e) => {
                    e.target.style.display = !!this.binFileUrl ? "" : "none";
                },
            }, {
                label: "Continue Manually",
                onClick: this.continueManuallyHandler,
            }],
        },
        // Manual UF2 copy step shown to Firefox users who chose
        // "Continue Manually" in fsapiUnavailable. We hand them a
        // direct download link to the UF2 file (we already have
        // uf2FileUrl) and tell them how to drag it onto the BOOT
        // drive. Advance is on a "Next" button rather than a folder
        // picker, since we can't programmatically observe the copy.
        manualBootCopy: {
            closeable: true,
            template: (data) => html`
                <h3>Copy CircuitPython onto the ${data.drivename} drive</h3>
                <ol>
                    <li>
                        <p>
                            <strong>Reset your board.</strong> Press the
                            RESET button once. A new drive named
                            <code>${data.drivename}</code> should appear
                            on your computer in a few seconds.
                        </p>
                    </li>
                    <li>
                        <p>
                            <strong>Download the CircuitPython UF2 file.</strong>
                            <a href="${data.uf2FileUrl}" download target="_blank" rel="noopener">
                                Download <code>${data.uf2FileName}</code>
                            </a>
                        </p>
                    </li>
                    <li>
                        <p>
                            <strong>Drag the downloaded UF2 file onto the
                            <code>${data.drivename}</code> drive.</strong>
                            The drive will disappear when the copy is
                            finished and the board reboots into
                            CircuitPython.
                        </p>
                    </li>
                </ol>
                <p>
                    Click <strong>Next</strong> once you've dragged the
                    file onto the drive.
                </p>
            `,
            buttons: [this.previousButton, this.nextButton],
        },
        // Lightweight "waiting for CIRCUITPY" beat between the manual
        // copy and the success screen. Pure-instructional since we
        // can't actually detect the drive without FSAPI.
        manualCircuitPyWait: {
            closeable: true,
            template: (data) => html`
                <h3>Waiting for CIRCUITPY</h3>
                <p>
                    Once your board finishes copying CircuitPython, a new
                    drive named <code>CIRCUITPY</code> should appear in a
                    few seconds.
                </p>
                <p>
                    If it doesn't appear, the drive may have been renamed
                    or disabled in <code>boot.py</code> on a previous
                    install. You can still continue &mdash; CircuitPython
                    is running on your board either way.
                </p>
                <p>
                    Click <strong>Next</strong> when you're ready to wrap
                    up.
                </p>
            `,
            buttons: [this.previousButton, this.nextButton],
        },
        // Manual-mode success dialog. Replaces stepSuccess for the
        // Firefox manual path since we never set up WiFi and have no
        // ip / hostname info to show. Walks the user through editing
        // settings.toml themselves so they're not left wondering.
        manualSuccess: {
            closeable: true,
            template: (data) => html`
                <h3>CircuitPython is installed!</h3>
                <p>
                    Your board should now be running CircuitPython. If it
                    doesn't reboot automatically, press the RESET button
                    once.
                </p>
                <p>
                    <strong>To set up WiFi:</strong> open the
                    <code>CIRCUITPY</code> drive and create or edit a
                    file called <code>settings.toml</code> in the root.
                    Add lines like:
                </p>
                <pre style="white-space: pre; font-family: monospace;">CIRCUITPY_WIFI_SSID = "your-network"
CIRCUITPY_WIFI_PASSWORD = "your-password"
CIRCUITPY_WEB_API_PASSWORD = "passw0rd"
CIRCUITPY_WEB_API_PORT = 80</pre>
                <p>
                    Save the file, then press RESET on your board. Once
                    the board reconnects to WiFi you can edit code in a
                    browser via the
                    <a href="https://code.circuitpython.org/" target="_blank" rel="noopener">CircuitPython web code editor</a>.
                </p>
            `,
            buttons: [this.closeButton],
        },
        bootDriveSelect: {
            closeable: true,
            template: (data) => html`
                <h3>Select the ${data.drivename} Drive</h3>
                <ol>
                    <li>
                        <p>
                            <strong>Reset your board</strong> if you just installed the UF2 bootloader,
                            by pressing the RESET button.
                            If you already had the UF2 bootloader installed,
                            you may need to double-click the RESET button to start up the UF2 bootloader.
                        </p>
                    </li>
                    <li>
                        <p>
                            <button id="butSelectBootDrive" type="button" @click=${this.bootDriveSelectHandler.bind(this)}>Select ${data.drivename} Drive</button>
                            Select the ${data.drivename} drive where the UF2 file will be copied.
                        </p>
                    </li>
                </ul>
            `,
            buttons: [],
        },
        circuitpyDriveSelect: {
            closeable: true,
            template: (data) => html`
                <h3>Select the CIRCUITPY Drive</h3>
                <ul>
                    <li>
                        <p>
                            <button id="butSelectCpyDrive" type="button" @click=${this.circuitpyDriveSelectHandler.bind(this)}>Select CIRCUITPY Drive</button>
                            Select the CIRCUITPY Drive.
                            You may need to wait a few seconds for it to appear.
                            If you don't see your CIRCUITPY drive, it may be disabled in boot.py or you may have previously renamed it.
                        </p>
                    </li>
                </ul>
            `,
            buttons: [],
        },
        actionWaiting: {
            template: (data) => html`
                <p class="centered">${data.action}</p>
                <div class="loader"><div></div><div></div><div></div><div></div></div>
            `,
            buttons: [],
        },
        actionProgress: {
            template: (data) => html`
                <p>${data.action}</p>
                <progress id="stepProgress" max="100" value="${data.percentage}"> ${data.percentage}% </progress>
            `,
            buttons: [],
        },
        cpSerial: {
            closeable: true,
            template: (data) => html`
                <h3>Reconnect to serial</h3>
                <ul>
                    <li>
                        <button id="butConnect" type="button" @click=${this.cpSerialConnectHandler.bind(this)}>Connect</button>
                        Click this button to open the Web Serial connection menu.
                        If it is already connected, you can press it again if you need to select a different port.
                    </li>
                </ul>
                </p>
                <p>${data.serialPortInstructions}</p>
            `,
            buttons: [this.previousButton, {
                label: "Next",
                onClick: this.nextStep,
                isEnabled: async () => { return (this.currentStep < this.currentFlow.steps.length - 1) && !!this.replSerialDevice; },
                onUpdate: async (e) => { this.currentDialogElement.querySelector("#butConnect").innerText = !!this.replSerialDevice ? "Connected" : "Connect"; },
            }],
        },

        credentials: {
            closeable: true,
            template: (data) => html`
                <h3>Fill in settings.toml</h3>
                <p>
                    This step will write your network credentials to the settings.toml file on CIRCUITPY.
                    Make sure your board is running CircuitPython.
                </p>
                <p>
                    If you want to skip this step and fill in settings.toml later,
                    just close this dialog.
                </p>
                <fieldset>
                    <div class="field">
                        <label for="circuitpy_wifi_ssid">WiFi Network Name (SSID):</label>
                        <input id="circuitpy_wifi_ssid" class="setting-data" type="text" placeholder="WiFi SSID" value="${data.wifi_ssid}" />
                    </div>
                    <div class="field">
                        <label for="circuitpy_wifi_password">WiFi Password:</label>
                        <input id="circuitpy_wifi_password" class="setting-data" type="password" placeholder="WiFi Password" value="${data.wifi_password}" />
                    </div>
                    <div class="field">
                        <label for="circuitpy_web_api_password">Web Workflow API Password:</label>
                        <input id="circuitpy_web_api_password" class="setting-data" type="password" placeholder="Web Workflow API Password" value="${data.api_password}"  />
                    </div>
                    <div class="field">
                        <label for="circuitpy_web_api_port">Web Workflow API Port:</label>
                        <input id="circuitpy_web_api_port" class="setting-data" type="number" min="0" max="65535" placeholder="Web Workflow API Port" value="${data.api_port}"  />
                    </div>
                    ${data.mass_storage_disabled === true || data.mass_storage_disabled === false ?
                    html`<div class="field">
            <label for="circuitpy_drive"><input id="circuitpy_drive" class="setting" type="checkbox" value="disabled" ${data.mass_storage_disabled ? "checked" : ""} />Disable CIRCUITPY Drive (Required for write access)</label>
            </div>` : ''}
                </fieldset>
            `,
            buttons: [this.previousButton, {
                label: "Next",
                onClick: this.saveCredentials,
            }]
        },
        success: {
            closeable: true,
            template: (data) => html`
                <p>Successfully Completed</p>
                <p>If your device doesn't reboot automatically press the reset button once.</p>
                ${data.ip ?
                    html`<p>
                        You can edit files by going to <a href="http://${data.ip}/code/">http://${data.ip}/code/</a>.
                    </p>` : ''}
            `,
            buttons: [this.closeButton],
        },
        error: {
            closeable: true,
            template: (data) => {
                // Split the message on blank lines so callers can pass
                // multi-paragraph error text (e.g. an explanation followed
                // by remediation instructions) and have it render as
                // separate paragraphs in the dialog rather than one wall
                // of text. Single newlines are preserved as line breaks
                // within a paragraph via CSS white-space: pre-line.
                const paragraphs = String(data.message || "").split(/\n{2,}/);
                return html`
                    ${map(paragraphs, (p) => html`<p style="white-space: pre-line;">${p}</p>`)}
                `;
            },
            buttons: [this.closeButton],
        },
        warning: {
            closeable: true,
            // Same paragraph-splitting behavior as the error dialog.
            // Visually identical for now but kept separate so future
            // styling (icon, color) can differentiate user-recoverable
            // hiccups from real install errors.
            template: (data) => {
                const paragraphs = String(data.message || "").split(/\n{2,}/);
                return html`
                    ${map(paragraphs, (p) => html`<p style="white-space: pre-line;">${p}</p>`)}
                `;
            },
            buttons: [this.closeButton],
        },
    }

    getBoardName(boardId) {
        if (Object.keys(this.boardDefs).includes(boardId)) {
            return this.boardDefs[boardId].name;
        }
        return null;
    }

    getBoardOptions() {
        let options = [];
        for (let boardId of this.boardIds) {
            options.push({id: boardId, name: this.getBoardName(boardId)});
        }

        options.sort((a, b) => {
            let boardA = a.name.trim().toLowerCase();
            let boardB = b.name.trim().toLowerCase();
            if (boardA < boardB) {
                return -1;
            }
            if (boardA > boardB) {
                return 1;
            }
            return 0;
        });
        return options;
    }

    ////////// STEP FUNCTIONS //////////

    async stepWelcome() {
        // continueManuallyHandler mutates currentFlow.steps in place to
        // graft on the manual sub-flow. Since runFlow doesn't clone the
        // step array, that mutation would persist across runs and break
        // a subsequent automated run on Chrome. Snapshot the original
        // step list the first time we see each flow and restore it on
        // every welcome step so each run starts fresh. (Issue #24)
        if (this.currentFlow) {
            if (!this.currentFlow._originalSteps) {
                this.currentFlow._originalSteps = this.currentFlow.steps.slice();
            } else {
                this.currentFlow.steps = this.currentFlow._originalSteps.slice();
            }
            // If installBinInsteadHandler set this flag on the bin flow
            // and we're now running stepWelcome via Previous from
            // stepSerialConnect, redirect to uf2FullProgram's welcome
            // so the user lands back where they started. Clear the
            // flag whether we redirect or not so that a subsequent
            // fresh entry to the bin flow doesn't accidentally bounce.
            if (this.currentFlow._returnToUf2Welcome) {
                this.currentFlow._returnToUf2Welcome = false;
                const uf2Flow = this.flows.uf2FullProgram;
                if (uf2Flow) {
                    this.currentFlow = uf2Flow;
                    this.currentStep = 0;
                    await this.currentFlow.steps[this.currentStep].bind(this)();
                    return;
                }
            }
        }
        // Display Welcome Dialog
        this.showDialog(this.dialogs.welcome, {boardName: this.boardName});
    }

    // FSAPI capability gate for uf2FullProgram, run immediately after
    // stepWelcome. On browsers with the File System Access API this is
    // a no-op pass-through; on Firefox (no FSAPI) it pops the
    // fsapiUnavailable dialog and stops here. The user chooses Use
    // Another Browser / Install .bin Instead / Continue Manually. The
    // bin-based flows and the FSAPI-only flows don't include this
    // step: bin flows don't touch FSAPI, and the FSAPI-only flows are
    // already hidden from the menu when the API is missing. (Issue #24)
    async stepFsapiCheck() {
        if (this.hasFileSystemAccess) {
            await this.nextStep();
            return;
        }
        this.logMsg("FileSystem API not available; offering manual UF2 copy fallback.");
        // Tell the dialog whether the .bin fallback is actually
        // available for this board (i.e. a .bin URL is configured), so
        // it can include the .bin bullet and button. We bypass
        // binFullProgram.isEnabled() on purpose here because this
        // dialog is the user's informed-consent path: even native-USB
        // boards (which the menu would normally route through the UF2
        // flow) get the option to flash the raw .bin when their
        // browser can't drive the UF2 path. Button visibility is
        // gated by the same predicate via an onUpdate hook. (Issue #24)
        const binAvailable = !!this.binFileUrl;
        this.showDialog(this.dialogs.fsapiUnavailable, { binAvailable });
    }

    async stepSerialConnect() {
        // Display Serial Connect Dialog
        this.showDialog(this.dialogs.espSerialConnect);
    }

    async stepConfirm() {
        // Display Confirm Dialog
        this.showDialog(this.dialogs.confirm, {boardName: this.boardName});
    }

    async stepEraseAll() {
        // Display Erase Dialog
        this.showDialog(this.dialogs.actionWaiting, {
            action: "Erasing Flash...",
        });
        try {
            await this.esploader.eraseFlash();
        } catch (err) {
            this.errorMsg("Unable to finish erasing Flash memory. Please try again.");
        }
        await this.nextStep();
    }

    async stepFlashBin() {
        if (!this.binFileUrl) {
            // We shouldn't be able to get here, but just in case
            this.errorMsg("Missing bin file URL. Please make sure the installer button has this specified.");
            return;
        }

        await this.downloadAndInstall(this.binFileUrl);
        // The MD5 verification step inside downloadAndInstall reads the entire
        // flash back, and stepSetupRepl below does a DTR/RTS reset + REPL wake.
        // Both can take several seconds, so swap to a waiting indicator so the
        // user doesn't think the wizard is stuck on "Flashing 100%".
        this.showDialog(this.dialogs.actionWaiting, {
            action: "Resetting the board and opening the REPL...",
        });
        await this.espHardReset();
        await this.nextStep();
    }

    async stepBootloader() {
        if (!this.bootloaderUrl) {
            // We shouldn't be able to get here, but just in case
            this.errorMsg("Missing bootloader file URL. Please make sure the installer button has this specified.");
            return;
        }
        // Display Bootloader Dialog
        await this.downloadAndInstall(this.bootloaderUrl, 'combined.bin', true);
        await this.nextStep();
    }

    // Manual-copy variant of stepSelectBootDrive + stepCopyUf2 combined.
    // Hands the user a download link for the UF2 file and instructions
    // for dragging it onto the BOOT drive themselves, since we can't
    // open the drive programmatically without FSAPI.
    async stepManualBootCopy() {
        const bootloaderVolume = await this.getBootDriveName();
        // Pull a friendly filename out of the URL so the download
        // button shows something more useful than just "Download".
        let uf2FileName = "CircuitPython.uf2";
        try {
            const urlPath = new URL(this.uf2FileUrl, window.location.href).pathname;
            const tail = urlPath.split("/").filter(Boolean).pop();
            if (tail) {
                uf2FileName = tail;
            }
        } catch (e) {
            // Fall back to the default if URL parsing fails for any
            // reason; we'd rather render a generic name than a broken
            // dialog.
        }
        this.showDialog(this.dialogs.manualBootCopy, {
            drivename: bootloaderVolume ? bootloaderVolume : "Bootloader",
            uf2FileUrl: this.uf2FileUrl,
            uf2FileName: uf2FileName,
        });
    }

    // Manual-copy variant of the post-copy wait. Pure instructional;
    // user clicks Next when they're ready to move on.
    async stepManualCircuitPyWait() {
        this.showDialog(this.dialogs.manualCircuitPyWait);
    }

    // Manual-copy success page. Tells the user how to set up WiFi
    // by editing settings.toml themselves, since the auto-credentials
    // step doesn't run in manual mode.
    async stepManualSuccess() {
        this.showDialog(this.dialogs.manualSuccess);
    }

    async stepSelectBootDrive() {
        const bootloaderVolume = await this.getBootDriveName();

        if (bootloaderVolume) {
            this.logMsg(`Waiting for user to select a bootloader volume named ${bootloaderVolume}`);
        }

        // Display Select Bootloader Drive Dialog
        this.showDialog(this.dialogs.bootDriveSelect, {
            drivename: bootloaderVolume ? bootloaderVolume : "Bootloader",
        });
    }

    async stepSelectCpyDrive() {
        this.logMsg(`Waiting for user to select CIRCUITPY drive`);

        // Display Select CIRCUITPY Drive Dialog
        this.showDialog(this.dialogs.circuitpyDriveSelect);
    }

    async stepCopyUf2() {
        if (!this.bootDriveHandle) {
            this.errorMsg("No boot drive selected. stepSelectBootDrive should preceed this step.");
            return;
        }
        // Display Progress Dialog
        this.showDialog(this.dialogs.actionProgress, {
            action: `Copying ${this.uf2FileUrl}...`,
        });

        // Do a copy and update progress along the way
        await this.downloadAndCopy(this.uf2FileUrl);

        // Once done, call nextstep
        await this.nextStep();
    }

    async stepSetupRepl() {
        // Don't close the SerialPort between flash and REPL. On Pi 5 + CP2104
        // (and likely other USB-serial bridges) port.close() can hang
        // indefinitely after esptool-js's transport.disconnect(), and even
        // after a successful reopen the device often goes silent. Instead,
        // release esptool-js's hold on the port (reader/writer locks) WITHOUT
        // closing it, then reuse the same open port directly for REPL. The
        // port is already at 115200 baud, which is what CircuitPython REPL
        // uses. (Issue #22)
        const reusablePort = (this.transport && this.transport.device) || this.device;

        if (reusablePort) {
            try {
                // Release esptool-js's reader/writer locks without closing.
                if (this.transport) {
                    try {
                        if (this.transport.reader) {
                            try { await this.transport.reader.cancel(); } catch (e) { /* ignore */ }
                            try { this.transport.reader.releaseLock(); } catch (e) { /* ignore */ }
                            this.transport.reader = undefined;
                        }
                        if (this.transport.writer) {
                            try { this.transport.writer.releaseLock(); } catch (e) { /* ignore */ }
                            this.transport.writer = undefined;
                        }
                    } catch (e) {
                        console.warn("Could not release esptool-js locks (continuing):", e);
                    }
                    // Drop our refs to the transport but DO NOT call its
                    // disconnect() method (which would close the port).
                    this.transport = null;
                    this.device = null;
                    this.chip = null;
                    this.updateEspConnected(this.connectionStates.DISCONNECTED);
                }

                this.replSerialDevice = reusablePort;

                // The port is currently at the flash baud (e.g. 921600)
                // and Web Serial doesn't support changing baud on an open
                // port, so we must close and reopen at REPL baud (115200).
                // close() can hang on Pi/CP2104 so we race it with a timeout
                // and continue regardless.
                try {
                    await Promise.race([
                        reusablePort.close(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("close() timeout")), 2500)),
                    ]);
                } catch (err) {
                    // close() can hang on CP2104; we proceed regardless.
                }
                await new Promise((r) => setTimeout(r, 400));

                // Reopen at REPL baud. May still report InvalidStateError
                // if the platform is mid-close; retry with backoff.
                let opened = false;
                const openErrors = [];
                for (let attempt = 0; attempt < 8 && !opened; attempt++) {
                    try {
                        await Promise.race([
                            reusablePort.open({baudRate: ESP_ROM_BAUD}),
                            new Promise((_, reject) => setTimeout(() => reject(new Error("open() timeout")), 3000)),
                        ]);
                        opened = true;
                    } catch (err) {
                        openErrors.push(err && err.message ? err.message : String(err));
                        if (err && err.name === "InvalidStateError") {
                            await new Promise((r) => setTimeout(r, 400));
                            continue;
                        }
                        throw err;
                    }
                }
                if (!opened) {
                    throw new Error(`Could not reopen port at REPL baud (attempts: ${openErrors.join(" | ")})`);
                }

                // Toggle DTR/RTS to reset the chip into normal boot.
                try {
                    await reusablePort.setSignals({dataTerminalReady: false, requestToSend: true});
                    await new Promise((r) => setTimeout(r, 100));
                    await reusablePort.setSignals({dataTerminalReady: false, requestToSend: false});
                    await new Promise((r) => setTimeout(r, 500));
                } catch (err) {
                    console.warn("setSignals failed (continuing):", err);
                }

                await this.setupRepl();

                // Give CP time to boot, then send extra Ctrl-C to interrupt
                // code.py / safe mode prompts and force a fresh ">>>".
                for (let i = 0; i < 4; i++) {
                    await new Promise((r) => setTimeout(r, 750));
                    try {
                        await this.serialTransmit("\x03");
                    } catch (e) {
                        console.warn("follow-up Ctrl-C failed:", e);
                    }
                }
                await this.nextStep();
                return;
            } catch (err) {
                console.warn("Could not reuse already-open port; falling back to manual reconnect:", err);
                this.replSerialDevice = null;
            }
        }

        const serialPortName = await this.getSerialPortName();
        let serialPortInstructions ="There may be several devices listed. If you aren't sure which to choose, look for one that includes the name of your microcontroller.";
        if (serialPortName) {
            serialPortInstructions =`There may be several devices listed, but look for one called something like ${serialPortName}.`
        }
        this.showDialog(this.dialogs.cpSerial, {
            serialPortInstructions: serialPortInstructions
        });
    }

    async stepCredentials() {
        // Talking to the board over the REPL can take several seconds while
        // we read settings.toml; show a spinner so the UI doesn't appear hung.
        this.showDialog(this.dialogs.actionWaiting, {
            action: "Reading current settings from the board...",
        });
        // We may want to see if the board has previously been set up and fill in any values from settings.toml and boot.py
        this.tomlSettings = await this.getCurrentSettings();
        const parameters = {
            wifi_ssid: this.getSetting('CIRCUITPY_WIFI_SSID'),
            wifi_password: this.getSetting('CIRCUITPY_WIFI_PASSWORD'),
            api_password: this.getSetting('CIRCUITPY_WEB_API_PASSWORD', 'passw0rd'),
            api_port: this.getSetting('CIRCUITPY_WEB_API_PORT', 80),
        }

        if (this.hasNativeUsb()) {
            // TODO: Currently the control is just disabled and not used because we don't have anything to modify boot.py in place.
            // Setting mass_storage_disabled to true/false will display the checkbox with the appropriately checked state.
            //parameters.mass_storage_disabled = true;
            // This can be updated to use FileOps for ease of implementation
        }

        // Display Credentials Request Dialog
        this.showDialog(this.dialogs.credentials, parameters);
    }

    async stepSuccess() {
        let deviceHostInfo = {};
        if (this.repl) {
            // After writeSettings the board is rebooting and we have to wait
            // for the next REPL prompt + read network info; surface that as
            // a waiting state instead of leaving the form dialog up.
            this.showDialog(this.dialogs.actionWaiting, {
                action: "Waiting for the board to come back online...",
            });
            await this.repl.waitForPrompt();
            // If we were setting up Web Workflow, we may want to provide a link to code.circuitpython.org
            if (this.currentFlow && this.currentFlow.steps.includes(this.stepCredentials)) {
                deviceHostInfo = await this.getDeviceHostInfo();
            }
        }

        // Display Success Dialog
        this.showDialog(this.dialogs.success, deviceHostInfo);
    }

    async stepClose() {
        // Close the currently loaded dialog
        this.closeDialog();
    }

    ////////// HANDLERS //////////

    // Handler for the "Continue Manually" button on fsapiUnavailable.
    // The user has chosen to copy the UF2 themselves rather than
    // switching browsers, so swap the drive-picker tail of the current
    // flow for the manual variants. The welcome + fsapi-check steps
    // stay in place at the current index so the Previous button still
    // has something to go back to. We mutate currentFlow.steps in
    // place so previousButton / nextButton step counts stay correct,
    // then advance into the install. (Issue #24)
    // Handler for the "Install .bin Instead" button on fsapiUnavailable.
    // The user has chosen to skip the UF2 path entirely and just flash
    // the .bin firmware over USB. This swaps out the current flow for
    // binFullProgram, which doesn't touch the FileSystem API at all.
    // Tradeoff: no UF2 bootloader gets installed, so future firmware
    // updates have to come back through this installer. We surface
    // that tradeoff in the dialog copy.
    //
    // We deliberately bypass binFullProgram.isEnabled() (which gates
    // on !hasNativeUsb()) and start the flow directly: the menu still
    // honors that gate, but the dialog is the user's informed-consent
    // escape hatch where the gate is intentionally relaxed.
    //
    // We start at step 1 (stepSerialConnect) instead of step 0
    // (stepWelcome) because the user already saw uf2FullProgram's
    // welcome dialog moments ago and there's no point showing it
    // again. (Issue #24)
    async installBinInsteadHandler(e) {
        const binFlow = this.flows.binFullProgram;
        if (!binFlow || !this.binFileUrl) {
            // Shouldn't happen because the button is hidden when no
            // .bin URL is configured, but guard anyway.
            this.errorMsg("The .bin install option isn't available for this board.");
            return;
        }
        this.closeDialog();
        // Inline runFlow() but start at step 1 (stepSerialConnect) to
        // skip stepWelcome, which the user already saw via
        // uf2FullProgram. Snapshot bin flow's step list defensively in
        // case it ever grows mutating handlers like uf2FullProgram has.
        // We also set _returnToUf2Welcome on the bin flow so that
        // hitting Previous from stepSerialConnect lands the user back
        // at uf2FullProgram's welcome dialog (where they started), not
        // at binFullProgram's own welcome. The override is consumed
        // by stepWelcome; if the user later starts the bin flow fresh
        // from the menu, stepWelcome's restore logic clears the flag.
        // (Issue #24)
        this.currentFlow = binFlow;
        if (!this.currentFlow._originalSteps) {
            this.currentFlow._originalSteps = this.currentFlow.steps.slice();
        } else {
            this.currentFlow.steps = this.currentFlow._originalSteps.slice();
        }
        this.currentFlow._returnToUf2Welcome = true;
        this.currentStep = 1;
        await this.currentFlow.steps[this.currentStep].bind(this)();
    }

    async continueManuallyHandler(e) {
        if (!this.currentFlow) {
            // No flow is active, which shouldn't be possible from this
            // dialog. Just close and bail.
            this.closeDialog();
            return;
        }
        // Drop everything after the current step (the FSAPI-check step)
        // and graft on the manual sub-flow. The serial-connect /
        // confirm / erase / bootloader steps stay in place: we still
        // want to flash the UF2 bootloader for the user, we just can't
        // copy the UF2 onto the BOOT drive for them.
        const manualTail = [
            this.stepSerialConnect,
            this.stepConfirm,
            this.stepEraseAll,
            this.stepBootloader,
            this.stepManualBootCopy,
            this.stepManualCircuitPyWait,
            this.stepManualSuccess,
        ];
        this.currentFlow.steps = this.currentFlow.steps
            .slice(0, this.currentStep + 1)
            .concat(manualTail);
        await this.nextStep();
    }

    async bootDriveSelectHandler(e) {
        // Belt-and-suspenders: stepWelcome should have already shunted
        // Firefox users into the manual flow before they get here, and
        // uf2Only / credentialsOnlyDrive are hidden from the menu when
        // FSAPI is missing. If something still routes a no-FSAPI browser
        // into this handler, fail loudly with a user-facing message
        // instead of silently swallowing the TypeError as "user cancelled".
        if (!this.hasFileSystemAccess) {
            this.errorMsg("Your browser doesn't support the FileSystem API, so this installer can't pick the bootloader drive automatically. Try Chrome, Edge, or Opera (version 89 or newer).");
            return;
        }
        const bootloaderVolume = await this.getBootDriveName();
        let dirHandle;

        // This will need to show a dialog selector
        try {
            dirHandle = await window.showDirectoryPicker({mode: 'readwrite'});
        } catch (e) {
            // Likely the user cancelled the dialog
            return;
        }
        if (bootloaderVolume && bootloaderVolume != dirHandle.name) {
            if (!confirm(`The selected drive named ${dirHandle.name} does not match the expected name of ${bootloaderVolume}. Continue anyways?`)) {
                return;
            }
        }
        if (!await this._verifyPermission(dirHandle)) {
            alert("Unable to write to the selected folder");
            return;
        }

        this.bootDriveHandle = dirHandle;
        await this.nextStep();
    }

    async circuitpyDriveSelectHandler(e) {
        // Same belt-and-suspenders guard as bootDriveSelectHandler.
        // (Issue #24)
        if (!this.hasFileSystemAccess) {
            this.errorMsg("Your browser doesn't support the FileSystem API, so this installer can't pick the CIRCUITPY drive automatically. Try Chrome, Edge, or Opera (version 89 or newer).");
            return;
        }
        let dirHandle;

        // This will need to show a dialog selector
        try {
            dirHandle = await window.showDirectoryPicker({mode: 'readwrite'});
        } catch (e) {
            // Likely the user cancelled the dialog
            return;
        }
        // Check if boot_out.txt exists
        if (!(await this.getBootOut(dirHandle))) {
            alert(`Expecting a folder with boot_out.txt. Please select the root folder of your CIRCUITPY drive.`);
            return;
        }
        if (!await this._verifyPermission(dirHandle)) {
            alert("Unable to write to the selected folder");
            return;
        }

        this.circuitpyDriveHandle = dirHandle;
        await this.nextStep();
    }

    async espToolConnectHandler(e) {
        await this.onReplDisconnected(e);
        await this.espDisconnect();
        await this.setBaudRateIfChipSupports(PREFERRED_BAUDRATE);
        try {
            this.updateEspConnected(this.connectionStates.CONNECTING);
            await this.espConnect({
                log: (...args) => this.logMsg(...args),
                debug: (...args) => {},
                error: (...args) => this.errorMsg(...args),
            });
            this.updateEspConnected(this.connectionStates.CONNECTED);
        } catch (err) {
            // It's possible the dialog was also canceled here
            this.updateEspConnected(this.connectionStates.DISCONNECTED);
            if (err instanceof NotRomBootloaderError) {
                // The user picked an obviously-wrong port (e.g. TinyUF2 CDC
                // or a running CircuitPython port). Surface the specific
                // guidance from espConnect verbatim so they know what to
                // do, and offer a Continue button that drops them back
                // on the serial-connect dialog so they can pick the
                // right port without re-running the whole installer.
                // Also log to the console so it's visible in the
                // log output. (Issues #20, #24)
                this.warnMsg(err.message);
                this.showDialog(this.dialogs.notRomBootloader, { message: err.message });
            } else {
                this.errorMsg("Unable to open Serial connection to board. Make sure the port is not already in use by another application or in another browser tab. If installing the bootloader, make sure you are in ROM bootloader mode.");
            }
            return;
        }

        try {
            this.logMsg(`Connected to ${this.esploader.chip.CHIP_NAME}`);

            // check chip compatibility
            if (this.chipFamily == `${this.esploader.chip.CHIP_NAME}`.toLowerCase().replaceAll("-", "")) {
                this.logMsg("This chip checks out");

                // esploader-js doesn't have a disconnect event, so we can't use this
                //this.esploader.addEventListener("disconnect", () => {
                //    this.updateEspConnected(this.connectionStates.DISCONNECTED);
                //});

                await this.nextStep();
                return;
            }

            // Can't use it so disconnect now
            this.errorMsg("Oops, this is the wrong firmware for your board.")
            await this.espDisconnect();

        } catch (err) {
            if (this.transport) {
                await this.transport.disconnect();
            }
            // Disconnection before complete
            this.updateEspConnected(this.connectionStates.DISCONNECTED);
            this.errorMsg("Oops, we lost connection to your board before completing the install. Please check your USB connection and click Connect again. Refresh the browser if it becomes unresponsive.")
        }
    }

    async onSerialReceive(e) {
        await this.repl.onSerialReceive(e);
    }

    async cpSerialConnectHandler(e) {
        // Guard against re-entrant invocation. The user often clicks the
        // Connect button a second time when the first click appears to do
        // nothing (in reality we're still awaiting espDisconnect() and the
        // browser's port-chooser is loading). A second call into this handler
        // re-enters transport.disconnect() while the first close is still in
        // flight and throws "InvalidStateError: A call to close() is already
        // in progress". (Issue #22)
        if (this._cpSerialConnectInFlight) {
            return;
        }
        this._cpSerialConnectInFlight = true;

        const butConnect = this.currentDialogElement
            ? this.currentDialogElement.querySelector("#butConnect")
            : null;
        const butConnectOriginalText = butConnect ? butConnect.innerText : null;
        if (butConnect) {
            butConnect.disabled = true;
            butConnect.innerText = "Connecting…";
        }

        try {
            // Disconnect from the ESP Tool if Connected
            await this.espDisconnect();

            await this.onReplDisconnected(e);

            // Connect to the Serial Port and interact with the REPL
            try {
                this.replSerialDevice = await navigator.serial.requestPort();
            } catch (err) {
                // Likely the user cancelled the chooser dialog
                return;
            }

            try {
                await this.replSerialDevice.open({baudRate: ESP_ROM_BAUD});
            } catch (err) {
                console.error("Error. Unable to open Serial Port. Make sure it isn't already in use in another tab or application.");
                // Drop the unusable port so a retry doesn't try to reuse it
                this.replSerialDevice = null;
                return;
            }

            await this.setupRepl();

            this.nextStep();
        } finally {
            this._cpSerialConnectInFlight = false;
            if (butConnect) {
                butConnect.disabled = false;
                // Let the onUpdate handler reflect the new state on next render.
                butConnect.innerText = !!this.replSerialDevice
                    ? "Connected"
                    : (butConnectOriginalText || "Connect");
            }
        }
    }

    async setupRepl() {
        if (this.replSerialDevice) {
            this.repl = new REPL();
            this.repl.serialTransmit = this.serialTransmit.bind(this);

            this.replSerialDevice.addEventListener("message", this.onSerialReceive.bind(this));

            // Start the read loop
            this._readLoopPromise = this._readSerialLoop().catch(
                async function(error) {
                    console.warn("REPL read loop errored:", error);
                    await this.onReplDisconnected();
                }.bind(this)
            );

            if (this.replSerialDevice.writable) {
                this.writer = this.replSerialDevice.writable.getWriter();
                await this.writer.ready;
            } else {
                console.warn("setupRepl: no writable stream available");
            }

            // After a fresh flash + reset, CircuitPython has already printed
            // its ">>> " prompt to the serial line BEFORE our read loop
            // started, so nobody saw it. Send Ctrl-C to interrupt anything
            // that may be running (e.g. code.py looping at boot) and force
            // CircuitPython to print a fresh prompt that subsequent steps
            // (stepCredentials, stepSuccess) can latch onto via
            // repl.waitForPrompt(). CP may still be mid-boot at this point,
            // so we space the kicks out to give it a chance to be ready to
            // handle the interrupt. (Issue #22)
            try {
                await this.serialTransmit("\r\n");
                await new Promise((r) => setTimeout(r, 300));
                await this.serialTransmit("\x03");
                await new Promise((r) => setTimeout(r, 300));
                await this.serialTransmit("\x03\r\n");
            } catch (err) {
                console.warn("REPL wake-up Ctrl-C failed; continuing anyway:", err);
            }
        } else {
            console.warn("setupRepl called with no replSerialDevice");
        }
    }

    async onReplDisconnected(e) {
        if (this.reader) {
            try {
                await this.reader.cancel();
            } catch(e) {
                // Ignore
            }
            this.reader = null;
        }
        if (this.writer) {
            await this.writer.releaseLock();
            this.writer = null;
        }

        if (this.replSerialDevice) {
            try {
                await this.replSerialDevice.close();
            } catch(e) {
                // Ignore
            }
            this.replSerialDevice = null;
        }
    }

    async buttonClickHandler(e, skipBoardSelector = false) {
        if (this.boardIds.length > 1 && (!this.selectedBoardId || !skipBoardSelector)) {
            this.showDialog(this.dialogs.boardSelect, {
                boards: this.getBoardOptions(),
                default: this.selectedBoardId,
            });

            this.currentDialogElement.querySelector("#availableBoards").addEventListener(
                "change", this.updateButtons.bind(this)
            );

            return;
        }

        await this.loadBoard(this.selectedBoardId);

        super.buttonClickHandler(e);
    }

    async selectBoardHandler(e) {
        const selectedValue = this.currentDialogElement.querySelector("#availableBoards").value;
        if (Object.keys(this.boardDefs).includes(selectedValue)) {
            this.selectedBoardId = selectedValue;
            this.closeDialog();

            this.buttonClickHandler(null, true);
        }
    }

    //////////////// FILE HELPERS ////////////////

    async getBootDriveName() {
        if (this._bootDriveName) {
            return this._bootDriveName;
        }
        await this.extractBootloaderInfo();

        return this._bootDriveName;
    }

    async getSerialPortName() {
        if (this._serialPortName) {
            return this._serialPortName;
        }
        await this.extractBootloaderInfo();

        return this._serialPortName;
    }

    async _verifyPermission(folderHandle) {
        const options = {mode: 'readwrite'};

        if (await folderHandle.queryPermission(options) === 'granted') {
            return true;
        }

        if (await folderHandle.requestPermission(options) === 'granted') {
            return true;
        }

        return false;
    }

    async extractBootloaderInfo() {
        if (!this.bootloaderUrl) {
            return false;
        }

        // Download the bootloader zip file
        let [filename, extracted_filename, fileBlob] =
            await this.downloadAndExtract(this.bootloaderUrl, 'tinyuf2.bin');
        const fileContents = await fileBlob.text();

        const bootDriveRegex = /B\x00B\x00([A-Z0-9\x00]{11})FAT16/;
        const serialNameRegex = /0123456789ABCDEF(.+)\x00UF2/;
        // Not sure if manufacturer is displayed. If not, we should use this instead
        // const serialNameRegex = /0123456789ABCDEF(?:.*\x00)?(.+)\x00UF2/;

        let matches = fileContents.match(bootDriveRegex);
        if (matches && matches.length >= 2) {
            // Strip any null characters from the name
            this._bootDriveName = matches[1].replace(/\0/g, '');
        }

        matches = fileContents.match(serialNameRegex);
        if (matches && matches.length >= 2) {
            // Replace any null characters with spaces
            this._serialPortName = matches[1].replace(/\0/g, ' ');
        }

        this.removeCachedFile(this.bootloaderUrl.split("/").pop());
    }

    async getBootOut(dirHandle) {
        return await this.readFile("boot_out.txt", dirHandle);
    }

    async readFile(filename, dirHandle = null) {
        // Read a file from the given directory handle

        if (!dirHandle) {
            dirHandle = this.circuitpyDriveHandle;
        }
        if (!dirHandle) {
            console.warn("CIRCUITPY Drive not selected and no Directory Handle provided");
            return null;
        }
        try {
            const fileHandle = await dirHandle.getFileHandle(filename);
            const fileData = await fileHandle.getFile();

            return await fileData.text();
        } catch (e) {
            return null;
        }
    }

    async writeFile(filename, contents, dirHandle = null) {
        // Write a file to the given directory handle
        if (!dirHandle) {
            dirHandle = this.circuitpyDriveHandle;
        }
        if (!dirHandle) {
            console.warn("CIRCUITPY Drive not selected and no Directory Handle provided");
            return null;
        }

        const fileHandle = await dirHandle.getFileHandle(filename, {create: true});
        const writable = await fileHandle.createWritable();
        await writable.write(contents);
        await writable.close();
    }


    //////////////// DOWNLOAD HELPERS ////////////////

    addCachedFile(filename, blob) {
        this.fileCache.push({
            filename: filename,
            blob: blob
        });
    }

    getCachedFile(filename) {
        for (let file of this.fileCache) {
            if (file.filename === filename) {
                return file.contents;
            }
        }
        return null;
    }

    removeCachedFile(filename) {
        for (let file of this.fileCache) {
            if (file.filename === filename) {
                this.fileCache.splice(this.fileCache.indexOf(file), 1);
            }
        }
    }

    async downloadFile(url, progressElement) {
        let response;
        try {
            response = await fetch(url);
        } catch (err) {
            this.errorMsg(`Unable to download file: ${url}`);
            return null;
        }

        const body = response.body;
        const reader = body.getReader();
        const contentLength = +response.headers.get('Content-Length');
        let receivedLength = 0;
        let chunks = [];
        while(true) {
            const {done, value} = await reader.read();
            if (done) {
                break;
            }
            chunks.push(value);
            receivedLength += value.length;
            progressElement.value = Math.round((receivedLength / contentLength) * 100);
            this.logMsg(`Received ${receivedLength} of ${contentLength}`)
        }
        let chunksAll = new Uint8Array(receivedLength);
        let position = 0;
        for(let chunk of chunks) {
            chunksAll.set(chunk, position);
            position += chunk.length;
        }

        let result = new Blob([chunksAll]);

        return result;
    }

    async downloadAndExtract(url, fileToExtract = null, cacheFile = false) {
        // Display Progress Dialog
        let filename = url.split("/").pop();
        let fileBlob = this.getCachedFile(filename);

        if (!fileBlob) {
            this.showDialog(this.dialogs.actionProgress, {
                action: `Downloading ${filename}...`
            });

            const progressElement = this.currentDialogElement.querySelector("#stepProgress");

            // Download the file at the url updating the progress in the process
            fileBlob = await this.downloadFile(url, progressElement);

            if (cacheFile) {
                this.addCachedFile(filename, fileBlob);
            }
        }

        // If the file is a zip file, unzip and find the file to extract
        let extracted_filename = null;
        if (filename.endsWith(".zip") && fileToExtract) {
            let foundFile;
            // Update the Progress dialog
            this.showDialog(this.dialogs.actionProgress, {
                action: html`<p>Downloaded ${filename}</p><p>Extracting ${fileToExtract}...</p>`
            });

            // Set that to the current file to flash
            [foundFile, fileBlob] = await this.findAndExtractFromZip(fileBlob, fileToExtract);
            if (!fileBlob) {
                this.errorMsg(`Unable to find ${fileToExtract} in ${filename}`);
                return;
            }
            extracted_filename = foundFile;
        }

        return [filename, extracted_filename, fileBlob];
    }

    async downloadAndInstall(url, fileToExtract = null, cacheFile = false) {
        let [filename, extracted_filename, fileBlob] = await this.downloadAndExtract(url, fileToExtract, cacheFile);
        const fileArray = [];

        const readBlobAsArrayBuffer = (inputFile) => {
            const reader = new FileReader();

            return new Promise((resolve, reject) => {
                reader.onerror = () => {
                    reader.abort();
                    reject(new DOMException("Problem parsing input file"));
                };

                reader.onload = () => {
                    resolve(reader.result);
                };
                reader.readAsArrayBuffer(inputFile);
            });
        };

        // Update the Progress dialog
        if (fileBlob) {
            fileArray.push({ data: new Uint8Array(await readBlobAsArrayBuffer(fileBlob)), address: 0 });

            let lastPercent = 0;
            this.showDialog(this.dialogs.actionProgress, {
                action: fileToExtract
                     ?  html`<p>Downloaded ${filename}</p><p>Extracted ${fileToExtract}</p><p>Flashing (be patient; you will see pauses)...</p>`
                      : html`<p>Downloaded ${filename}</p>Flashing (be patient; you will see pauses)...</p>`
            });

            const progressElement = this.currentDialogElement.querySelector("#stepProgress");
            progressElement.value = 0;

            try {
                const flashOptions = {
                    fileArray: fileArray,
                    flashSize: "keep",
                    eraseAll: false,
                    compress: true,
                    reportProgress: (fileIndex, written, total) => {
                        let percentage = Math.round((written / total) * 100);
                        if (percentage > lastPercent) {
                            progressElement.value = percentage;
                            this.logMsg(`${percentage}% (${written}/${total})...`);
                            lastPercent = percentage;
                        }
                    },
                    // Enable post-flash MD5 verification. Without this,
                    // esptool-js skips its readback hash check, which can
                    // mask flash-write corruption on some USB-serial
                    // bridges (e.g. Pi 5 + CP2104, see issue #22).
                    //
                    // The host page is responsible for loading a hashing
                    // library; CryptoJS is recommended. If no compatible
                    // library is present we return null and esptool-js
                    // simply skips verification (matching the previous
                    // behavior).
                    calculateMD5Hash: (image) => {
                        if (typeof CryptoJS !== "undefined"
                            && CryptoJS.MD5
                            && CryptoJS.lib && CryptoJS.lib.WordArray
                            && CryptoJS.enc && CryptoJS.enc.Hex) {
                            const wordArray = CryptoJS.lib.WordArray.create(image);
                            return CryptoJS.MD5(wordArray).toString(CryptoJS.enc.Hex);
                        }
                        return null;
                    },
                };
                await this.esploader.writeFlash(flashOptions);
            } catch (err) {
                this.errorMsg(`Unable to flash file: ${fileToExtract}. Error Message: ${err}`);
                throw err;  // don't proceed to setup REPL on a bad flash
            }
        }
    }

    async downloadAndCopy(url, dirHandle = null) {
        if (!dirHandle) {
            dirHandle = this.bootDriveHandle;
        }
        if (!dirHandle) {
            this.errorMsg("No drive handle available");
            return;
        }

        let [filename, extracted_filename, fileBlob] = await this.downloadAndExtract(url);
        this.showDialog(this.dialogs.actionProgress, {
            action: html`<p>Downloaded: ${filename}</p><p>Flashing...</p>`
        });

        const progressElement = this.currentDialogElement.querySelector("#stepProgress");
        progressElement.value = 0;

        const fileHandle = await dirHandle.getFileHandle(filename, {create: true});
        const writableStream = await fileHandle.createWritable();
        const totalSize = fileBlob.size;
        let bytesWritten = 0;
        let chunk;
        while(bytesWritten < totalSize) {
            chunk = fileBlob.slice(bytesWritten, bytesWritten + COPY_CHUNK_SIZE);
            await writableStream.write(chunk, {position: bytesWritten, size: chunk.size});

            bytesWritten += chunk.size;
            progressElement.value = Math.round(bytesWritten / totalSize * 100);
            this.logMsg(`${Math.round(bytesWritten / totalSize * 100)}% (${bytesWritten} / ${totalSize}) written...`);
        }
        this.logMsg("File successfully written");
        try {
            // Attempt to close the file, but since the device reboots, it may error
            await writableStream.close();
            this.logMsg("File successfully closed");
        } catch (err) {
            this.logMsg("Error closing file, probably due to board reset. Continuing...");
        }
    }

    async findAndExtractFromZip(zipBlob, filename) {
        const reader = new zip.ZipReader(new zip.BlobReader(zipBlob));

        // unzip into local file cache
        let zipContents = await reader.getEntries();

        for(const zipEntry of zipContents) {
            if (zipEntry.filename.localeCompare(filename) === 0) {
                const extractedFile = await zipEntry.getData(new zip.BlobWriter());
                return [zipEntry.filename, extractedFile];
            }
        }

        return [null, null];
    }


    //////////////// OTHER HELPERS ////////////////

    async saveCredentials() {
        this.saveSetting('CIRCUITPY_WIFI_SSID');
        this.saveSetting('CIRCUITPY_WIFI_PASSWORD');
        this.saveSetting('CIRCUITPY_WEB_API_PASSWORD');
        this.saveSetting('CIRCUITPY_WEB_API_PORT');

        // writeSettings issues several runCode round-trips over the REPL
        // which can take a noticeable amount of time. Show a spinner so the
        // wizard doesn't look frozen.
        this.showDialog(this.dialogs.actionWaiting, {
            action: "Writing settings to the board...",
        });
        await this.writeSettings(this.tomlSettings);
        if (this.hasNativeUsb()) {
            //this.setBootDisabled(true);
        }
        await this.nextStep();
    }

    getSetting(setting, defaultValue = '') {
        if (this.tomlSettings && this.tomlSettings.hasOwnProperty(setting)) {
            return this.tomlSettings[setting];
        }

        return defaultValue;
    }

    async getBootDisabled() {
        // This is a very simple check for now. If there is something more complicated like a disable
        // command behind an if statement, this will not detect it is enabled.
        let fileContents;
        if (this.repl) {
            return true; // Always disabled in this case
        } else if (this.circuitpyDriveHandle) {
            fileContents = await this.readFile("boot.py");
            // TODO: Compare board's boot.py to our boot.py by
            // searching for storage.disable_usb_drive() at the beginning of the line
        } else {
            this.errorMsg("Connect to the CIRCUITPY drive or the REPL first");
            return {};
        }

        if (fileContents) {
            return toml.parse(fileContents);
        }
        this.logMsg("Unable to read settings.toml from CircuitPython. It may not exist. Continuing...");
        return {};
    }

    saveBootDisabled(disabled) {
        // TODO: Save/remove a copy of boot.py on the CIRCUITPY drive
        // This depends on whether it is currently disabled in boot.py and what the value of disabled is
        // If they are the same, we can skip
        // An idea is to only deal with this if boot.py doesn't exist and just use a generic boot.py
        // For disabling, we can compare to the generic and if they are different refuse to touch it
        const formElement = this.currentDialogElement.querySelector('#circuitpy_drive');
        if (formElement) {
            if (formElement.checked) {
                this.tomlSettings['CIRCUITPY_DRIVE'] = "disabled";
            } else {
                this.tomlSettings['CIRCUITPY_DRIVE'] = "enabled";
            }
        }

    }

    saveSetting(settingName) {
        const formElement = this.currentDialogElement.querySelector(`#${settingName.toLowerCase()}`)
        if (formElement) {
            if (formElement.type == "number") {
                this.tomlSettings[settingName] = parseInt(formElement.value);
            } else if (formElement.type == "text" || formElement.type == "password") {
                this.tomlSettings[settingName] = formElement.value;
            } else {
                this.errorMsg(`A setting was found, but a form element of type ${formElement.type} was not expected.`);
            }
        } else {
            this.errorMsg(`A setting named '${settingName}' was not found.`);
        }
    }

    async runCode(code, outputToConsole = true) {
        if (Array.isArray(code)) {
            code = code.join("\n");
        }

        if (this.repl) {
            const output = await this.repl.runCode(code);

            if (outputToConsole) {
                console.log(output);
            }
        }
    }

    async writeSettings(settings) {
        if (this.repl) {
            await this.runCode(`import storage`);
            await this.runCode(`storage.remount("/", False)`);
            await this.runCode(`f = open('settings.toml', 'w')`);

            for (const [setting, value] of Object.entries(settings)) {
                if (typeof value === "string") {
                    await this.runCode(`f.write('${setting} = "${value}"\\n')`);
                } else {
                    await this.runCode(`f.write('${setting} = ${value}\\n')`);
                }
            }
            await this.runCode(`f.close()`);

            // Perform a soft restart to avoid losing the connection and get an IP address
            this.showDialog(this.dialogs.actionWaiting, {
                action: "Waiting for IP Address...",
            });
            await this.repl.softRestart();
            try {
                await this.timeout(
                    async () => {
                        let deviceInfo = {};
                        while (Object.entries(deviceInfo).length == 0 || deviceInfo.ip === null) {
                            deviceInfo = await this.getDeviceHostInfo();
                            await this.sleep(300);
                        }
                    }, 10000
                );
            } catch (error) {
                console.warn("Unable to get IP Address. Network Credentials may be incorrect");
                return null;
            }
        } else if (this.circuitpyDriveHandle) {
            const contents = toml.stringify(settings);
            await this.writeFile("settings.toml", contents);
        } else {
            this.errorMsg("Connect to the CIRCUITPY drive or the REPL first");
            return null;
        }
    }

    async getCurrentSettings() {
        let fileContents;
        if (this.repl) {
            fileContents = await this.runCode(["f = open('settings.toml', 'r')", "print(f.read())", "f.close()"]);
        } else if (this.circuitpyDriveHandle) {
            fileContents = await this.readFile("settings.toml");
        } else {
            this.errorMsg("Connect to the CIRCUITPY drive or the REPL first");
            return {};
        }

        if (fileContents) {
            return toml.parse(fileContents);
        }
        this.logMsg("Unable to read settings.toml from CircuitPython. It may not exist. Continuing...");
        return {};
    }

    async serialTransmit(msg) {
        const encoder = new TextEncoder();
        if (this.writer) {
            const encMessage = encoder.encode(msg);
            await this.writer.ready.catch((err) => {
                this.errorMsg(`Ready error: ${err}`);
            });
            await this.writer.write(encMessage).catch((err) => {
                this.errorMsg(`Chunk error: ${err}`);
            });
            await this.writer.ready;
        }
    }

    async _readSerialLoop() {
        if (!this.replSerialDevice) {
            return;
        }

        const messageEvent = new Event("message");
        const decoder = new TextDecoder();

        if (this.replSerialDevice.readable) {
            this.reader = this.replSerialDevice.readable.getReader();
            while (true) {
                const {value, done} = await this.reader.read();
                if (value) {
                    messageEvent.data = decoder.decode(value);
                    this.replSerialDevice.dispatchEvent(messageEvent);
                }
                if (done) {
                    this.reader.releaseLock();
                    await this.onReplDisconnected();
                    break;
                }
            }
        }

        this.logMsg("Read Loop Stopped. Closing Serial Port.");
    }

    async getDeviceHostInfo() {
        // For now return info from title
        if (this.repl) {
            return {
                ip: this.repl.getIpAddress(),
                version: this.repl.getVersion(),
            };
        }

        return {};

        // TODO: (Maybe) Retreive some device info via the REPL (mDNS Hostname and IP Address)
        // import wifi
        // import mdns
        // wifi.radio.ipv4_address
        // server = mdns.Server(wifi.radio)
        // server.hostname
    }

    // This is necessary because chips with native USB will have a CIRCUITPY drive, which blocks writing via REPL
    hasNativeUsb() {
        if (!this.chipFamily || this.chipFamily == "esp32" || this.chipFamily.startsWith("esp32c")) {
            return false;
        }

        // Since most new chips have it, we return true by default.
        return true;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    timeout(callback, ms) {
        return Promise.race([callback(), this.sleep(ms).then(() => {throw Error("Timed Out");})]);
    }
}

customElements.define('cp-install-button', CPInstallButton, {extends: "button"});
