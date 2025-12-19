// SPDX-FileCopyrightText: 2023 Melissa LeBlanc-Williams for Adafruit Industries
//
// SPDX-License-Identifier: MIT

'use strict';
import { html } from 'https://cdn.jsdelivr.net/npm/lit-html/+esm';
import { map } from 'https://cdn.jsdelivr.net/npm/lit-html/directives/map/+esm';
import * as toml from "https://cdn.jsdelivr.net/npm/iarna-toml-esm@3.0.5/+esm"
import * as zip from "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.6.65/+esm";
import { default as CryptoJS } from "https://cdn.jsdelivr.net/npm/crypto-js@4.1.1/+esm";
import { REPL } from 'https://cdn.jsdelivr.net/gh/adafruit/circuitpython-repl-js@3.2.1/repl.js';
import { InstallButton, ESP_ROM_BAUD } from "./base_installer.js";

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
            steps: [this.stepWelcome, this.stepSerialConnect, this.stepConfirm, this.stepEraseAll, this.stepBootloader, this.stepSelectBootDrive, this.stepCopyUf2, this.stepSelectCpyDrive, this.stepCredentials, this.stepSuccess],
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
            isEnabled: async () => { return this.hasNativeUsb() && !!this.uf2FileUrl },
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
            isEnabled: async () => { return this.hasNativeUsb() },
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
                ${data.ip ?
                    html`<p>
                        You can edit files by going to <a href="http://${data.ip}/code/">http://${data.ip}/code/</a>.
                    </p>` : ''}
            `,
            buttons: [this.closeButton],
        },
        error: {
            closeable: true,
            template: (data) => html`
                <p>Installation Error: ${data.message}</p>
            `,
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
        // Display Welcome Dialog
        this.showDialog(this.dialogs.welcome, {boardName: this.boardName});
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
            action: "Erasing Flash ...",
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
            action: `Copying ${this.uf2FileUrl} ...`,
        });

        // Do a copy and update progress along the way
        await this.downloadAndCopy(this.uf2FileUrl);

        // Once done, call nextstep
        await this.nextStep();
    }

    async stepSetupRepl() {
        // TODO: Try and reuse the existing connection so user doesn't need to select it again
        /*if (this.device) {
            this.replSerialDevice = this.device;
            await this.setupRepl();
        }*/
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
        // We may want to see if the board has previously been set up and fill in any values from settings.toml and boot.py
        this.tomlSettings = await this.getCurrentSettings();
        console.log(this.tomlSettings);
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
            await this.repl.waitForPrompt();
            // If we were setting up Web Workflow, we may want to provide a link to code.circuitpython.org
            if (this.currentFlow || this.currentFlow.steps.includes(this.stepCredentials)) {
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

    async bootDriveSelectHandler(e) {
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
            this.errorMsg("Unable to open Serial connection to board. Make sure the port is not already in use by another application or in another browser tab. If installing the bootloader, make sure you are in ROM bootloader mode.");
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
        // Disconnect from the ESP Tool if Connected
        await this.espDisconnect();

        await this.onReplDisconnected(e);

        // Connect to the Serial Port and interact with the REPL
        try {
            this.replSerialDevice = await navigator.serial.requestPort();
        } catch (e) {
            // Likely the user cancelled the dialog
            return;
        }

        try {
            await this.replSerialDevice.open({baudRate: ESP_ROM_BAUD});
        } catch (e) {
            console.error("Error. Unable to open Serial Port. Make sure it isn't already in use in another tab or application.");
        }

        await this.setupRepl();

        this.nextStep();
    }

    async setupRepl() {
        if (this.replSerialDevice) {
            this.repl = new REPL();
            this.repl.serialTransmit = this.serialTransmit.bind(this);

            this.replSerialDevice.addEventListener("message", this.onSerialReceive.bind(this));

            // Start the read loop
            this._readLoopPromise = this._readSerialLoop().catch(
                async function(error) {
                    await this.onReplDisconnected();
                }.bind(this)
            );

            if (this.replSerialDevice.writable) {
                this.writer = this.replSerialDevice.writable.getWriter();
                await this.writer.ready;
            }
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
                action: `Downloading ${filename} ...`
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
                action: html`<p>Downloaded ${filename}</p><p>Extracting ${fileToExtract} ...</p>`
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

        const readBlobAsBinaryString = (inputFile) => {
            const reader = new FileReader();

            return new Promise((resolve, reject) => {
                reader.onerror = () => {
                    reader.abort();
                    reject(new DOMException("Problem parsing input file"));
                };

                reader.onload = () => {
                    resolve(reader.result);
                };
                reader.readAsBinaryString(inputFile);
            });
        };

        // Update the Progress dialog
        if (fileBlob) {
            fileArray.push({ data: await readBlobAsBinaryString(fileBlob), address: 0 });

            let lastPercent = 0;
            this.showDialog(this.dialogs.actionProgress, {
                action: fileToExtract
                     ?  html`<p>Downloaded ${filename}</p><p>Extracted ${fileToExtract}</p><p>Flashing (be patient; you will see pauses) ...</p>`
                      : html`<p>Downloaded ${filename}</p>Flashing (be patient; you will see pauses) ...</p>`
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
                            this.logMsg(`${percentage}% (${written}/${total}) ...`);
                            lastPercent = percentage;
                        }
                    },
                    calculateMD5Hash: (image) => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)),
                };
                await this.esploader.writeFlash(flashOptions);
            } catch (err) {
                this.errorMsg(`Unable to flash file: ${fileToExtract}. Error Message: ${err}`);
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
            action: html`<p>Downloaded: ${filename}</p><p>Flashing ...</p>`
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
            this.logMsg(`${Math.round(bytesWritten / totalSize * 100)}% (${bytesWritten} / ${totalSize}) written ...`);
        }
        this.logMsg("File successfully written");
        try {
            // Attempt to close the file, but since the device reboots, it may error
            await writableStream.close();
            this.logMsg("File successfully closed");
        } catch (err) {
            this.logMsg("Error closing file, probably due to board reset. Continuing ...");
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
        this.logMsg("Unable to read settings.toml from CircuitPython. It may not exist. Continuing ...");
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
                action: "Waiting for IP Address ...",
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
        this.logMsg("Unable to read settings.toml from CircuitPython. It may not exist. Continuing ...");
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
