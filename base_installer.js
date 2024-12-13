// SPDX-FileCopyrightText: 2023 Melissa LeBlanc-Williams for Adafruit Industries
//
// SPDX-License-Identifier: MIT

'use strict';
import {html, render} from 'https://cdn.jsdelivr.net/npm/lit-html/+esm';
import {asyncAppend} from 'https://cdn.jsdelivr.net/npm/lit-html/directives/async-append/+esm';
import { ESPLoader, Transport } from "https://unpkg.com/esptool-js@0.5.1/bundle.js";
export const ESP_ROM_BAUD = 115200;

export class InstallButton extends HTMLButtonElement {
    static isSupported = 'serial' in navigator;
    static isAllowed = window.isSecureContext;

    constructor() {
        super();
        this.baudRate = ESP_ROM_BAUD;
        this.dialogElements = {};
        this.currentFlow = null;
        this.currentStep = 0;
        this.currentDialogElement = null;
        this.device = null;
        this.transport = null;
        this.esploader = null;
        this.chip = null;
        this.dialogCssClass = "install-dialog";
        this.connected = this.connectionStates.DISCONNECTED;
        this.menuTitle = "Installer Menu";
    }

    init() {
        this.preloadDialogs();
    }

    // Define some common buttons
    /* Buttons should have a label, and a callback and optionally a condition function on whether they should be enabled */
    previousButton = {
        label: "Previous",
        onClick: this.prevStep,
        isEnabled: async () => { return this.currentStep > 0 },
    }

    nextButton = {
        label: "Next",
        onClick: this.nextStep,
        isEnabled: async () => { return this.currentStep < this.currentFlow.steps.length - 1; },
    }

    closeButton = {
        label: "Close",
        onClick: async (e) => {
            this.closeDialog();
        },
    }

    // Default Buttons
    defaultButtons = [this.previousButton, this.nextButton];

    // States and Button Labels
    connectionStates = {
        DISCONNECTED: "Connect",
        CONNECTING: "Connecting...",
        CONNECTED: "Disconnect",
    }

    dialogs = {
        notSupported: {
            preload: false,
            closeable: true,
            template: (data) => html`
                Sorry, <b>Web Serial</b> is not supported on your browser at this time. Browsers we expect to work:
                <ul>
                <li>Google Chrome 89 (and higher)</li>
                <li>Microsoft Edge 89 (and higher)</li>
                <li>Opera 75 (and higher)</li>
                </ul>
            `,
            buttons: [this.closeButton],
        },
        menu: {
            closeable: true,
            template: (data) => html`
                <p>${this.menuTitle}</p>
                <ul class="flow-menu">
                ${asyncAppend(this.generateMenu(
                    (flowId, flow) => html`<li><a href="#" @click=${this.runFlow.bind(this)} id="${flowId}">${flow.label.replace('[version]', this.releaseVersion)}</a></li>`
                ))}
                </ul>`,
            buttons: [this.closeButton],
        },
    };

    flows = {};

    baudRates = [
        115200,
        128000,
        153600,
        230400,
        460800,
        921600,
        1500000,
        2000000,
    ];

    connectedCallback() {
        if (InstallButton.isSupported && InstallButton.isAllowed) {
            this.toggleAttribute("install-supported", true);
        } else {
            this.toggleAttribute("install-unsupported", true);
        }

        this.addEventListener("click", async (e) => {
            e.preventDefault();
            // WebSerial feature detection
            if (!InstallButton.isSupported) {
                await this.showNotSupported();
            } else {
                await this.buttonClickHandler(e);
            }
        });
    }

    async buttonClickHandler(e) {
        await this.showMenu();
    }

    // Parse out the url parameters from the current url
    getUrlParams() {
        // This should look for and validate very specific values
        var hashParams = {};
        if (location.hash) {
            location.hash.substr(1).split("&").forEach(function(item) {hashParams[item.split("=")[0]] = item.split("=")[1];});
        }
        return hashParams;
    }

    // Get a url parameter by name and optionally remove it from the current url in the process
    getUrlParam(name) {
        let urlParams = this.getUrlParams();
        let paramValue = null;
        if (name in urlParams) {
            paramValue = urlParams[name];
        }

        return paramValue;
    }

    async enabledFlowCount() {
        let enabledFlowCount = 0;
        for (const [flowId, flow] of Object.entries(this.flows)) {
            if (await flow.isEnabled()) {
                enabledFlowCount++;
            }
        }
        return enabledFlowCount;
    }

    async * generateMenu(templateFunc) {
        if (await this.enabledFlowCount() == 0) {
            yield html`<li>No installable options available for this board.</li>`;
        }
        for (const [flowId, flow] of Object.entries(this.flows)) {
            if (await flow.isEnabled()) {
                yield templateFunc(flowId, flow);
            }
        }
    }

    preloadDialogs() {
        for (const [id, dialog] of Object.entries(this.dialogs)) {
            if ('preload' in dialog && !dialog.preload) {
                continue;
            }
            this.dialogElements[id] = this.getDialogElement(dialog);
        }
    }

    createIdFromLabel(text) {
        return text.replace(/^[^a-z]+|[^\w:.-]+/gi, "");
    }

    createDialogElement(id, dialogData) {
        // Check if an existing dialog with the same id exists and remove it if so
        let existingDialog = this.querySelector(`#cp-installer-${id}`);
        if (existingDialog) {
            this.remove(existingDialog);
        }

        // Create a dialog element
        let dialogElement = document.createElement("dialog");
        dialogElement.id = id;
        dialogElement.classList.add(this.dialogCssClass);

        // Add a close button
        let closeButton = document.createElement("button");
        closeButton.href = "#";
        closeButton.classList.add("close-button");
        closeButton.addEventListener("click", (e) => {
            e.preventDefault();
            dialogElement.close();
        });
        dialogElement.appendChild(closeButton);

        // Add a body element
        let body = document.createElement("div");
        body.classList.add("dialog-body");
        dialogElement.appendChild(body);

        let buttons = this.defaultButtons;
        if (dialogData && dialogData.buttons) {
            buttons = dialogData.buttons;
        }

        dialogElement.appendChild(
            this.createNavigation(buttons)
        );

        // Return the dialog element
        document.body.appendChild(dialogElement);
        return dialogElement;
    }

    createNavigation(buttonData) {
        // Add buttons according to config data
        const navigation = document.createElement("div");
        navigation.classList.add("dialog-navigation");

        for (const button of buttonData) {
            let buttonElement = document.createElement("button");
            buttonElement.innerText = button.label;
            buttonElement.id = this.createIdFromLabel(button.label);
            buttonElement.addEventListener("click", async (e) => {
                e.preventDefault();
                if (button.onClick instanceof Function) {
                    await button.onClick.bind(this)();
                } else if (button.onClick instanceof Array) {
                    let [func, ...params] = button.onClick;
                    await func.bind(this)(...params);
                }
            });
            buttonElement.addEventListener("update", async (e) => {
                if ("onUpdate" in button) {
                    await button.onUpdate.bind(this)(e);
                }
                if ("isEnabled" in button) {
                    e.target.disabled = !(await button.isEnabled.bind(this)());
                }
            });

            navigation.appendChild(buttonElement);
        }

        return navigation;
    }

    getDialogElement(dialog, forceReload = false) {
        function getKeyByValue(object, value) {
            return Object.keys(object).find(key => object[key] === value);
        }

        const dialogId = getKeyByValue(this.dialogs, dialog);

        if (dialogId) {
            if (dialogId in this.dialogElements && !forceReload) {
                return this.dialogElements[dialogId];
            } else {
                return this.createDialogElement(dialogId, dialog);
            }
        }
        return null;
    }

    updateButtons() {
        // Call each button's custom update event for the current dialog
        if (this.currentDialogElement) {
            const navButtons = this.currentDialogElement.querySelectorAll(".dialog-navigation button");
            for (const button of navButtons) {
                button.dispatchEvent(new Event("update"));
            }
        }
    }

    showDialog(dialog, templateData = {}) {
        if (this.currentDialogElement) {
            this.closeDialog();
        }

        this.currentDialogElement = this.getDialogElement(dialog);
        if (!this.currentDialogElement) {
            console.error(`Dialog not found`);
        }

        if (this.currentDialogElement) {
            const dialogBody = this.currentDialogElement.querySelector(".dialog-body");
            if ('template' in dialog) {
                render(dialog.template(templateData), dialogBody);
            }

            // Close button should probably hide during certain steps such as flashing and erasing
            if ("closeable" in dialog && dialog.closeable) {
                this.currentDialogElement.querySelector(".close-button").style.display = "block";
            } else {
                this.currentDialogElement.querySelector(".close-button").style.display = "none";
            }

            let dialogButtons = this.defaultButtons;
            if ('buttons' in dialog) {
                dialogButtons = dialog.buttons;
            }

            this.updateButtons();
            this.currentDialogElement.showModal();
        }
    }

    closeDialog() {
        this.currentDialogElement.close();
        this.currentDialogElement = null;
    }

    errorMsg(text) {
        text = this.stripHtml(text);
        console.error(text);
        this.showError(text);
    }

    logMsg(text, showTrace = false) {
        // TODO: Eventually add to an internal log that the user can bring up
        console.info(this.stripHtml(text));
        if (showTrace) {
            console.trace();
        }
    }

    updateEspConnected(connected) {
        if (Object.values(this.connectionStates).includes(connected)) {
            this.connected = connected;
            this.updateButtons();
        }
    }

    stripHtml(html) {
        let tmp = document.createElement("div");
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || "";
    }

    formatMacAddr(macAddr) {
        return macAddr.map((value) => value.toString(16).toUpperCase().padStart(2, "0")).join(":");
    }

    async espDisconnect() {
        if (this.transport) {
            await this.transport.disconnect();
            await this.transport.waitForUnlock(1500);
            this.updateEspConnected(this.connectionStates.DISCONNECTED);
            this.transport = null;
            this.device = null;
            this.chip = null;
            return true;
        }
        return false;
    }

    async runFlow(flow) {
        if (flow instanceof Event) {
            flow.preventDefault();
            flow.stopImmediatePropagation();
            if (flow.target.id in this.flows) {
                flow = this.flows[flow.target.id];
            } else {
                return;
            }
        }

        this.currentFlow = flow;
        this.currentStep = 0;
        await this.currentFlow.steps[this.currentStep].bind(this)();
    }

    async nextStep() {
        if (!this.currentFlow) {
            return;
        }

        if (this.currentStep < this.currentFlow.steps.length) {
            this.currentStep++;
            await this.currentFlow.steps[this.currentStep].bind(this)();
        }
    }

    async prevStep() {
        if (!this.currentFlow) {
            return;
        }

        if (this.currentStep > 0) {
            this.currentStep--;
            await this.currentFlow.steps[this.currentStep].bind(this)();
        }
    }

    async advanceSteps(stepCount) {
        if (!this.currentFlow) {
            return;
        }

        if (this.currentStep <= this.currentFlow.steps.length + stepCount) {
            this.currentStep += stepCount;
            await this.currentFlow.steps[this.currentStep].bind(this)();
        }
    }

    async showMenu() {
        // Display Menu
        this.showDialog(this.dialogs.menu);
    }

    async showNotSupported() {
        // Display Not Supported Message
        this.showDialog(this.dialogs.notSupported);
    }

    async showError(message) {
        // Display Menu
        this.showDialog(this.dialogs.error, {message: message});
    }

    async setBaudRateIfChipSupports(baud) {
        if (baud == this.baudRate) { return } // already the current setting

        await this.changeBaudRate(baud);
    }

    async changeBaudRate(baud) {
        if (this.baudRates.includes(baud)) {
            if (this.transport == null) {
                this.baudRate = baud;
            } else {
                this.errorMsg("Cannot change baud rate while connected.");
            }
        }
    }

    async espHardReset() {
        if (this.esploader) {
            await this.esploader.hardReset();
        }
    }

    async espConnect(logger) {
        logger.log("Connecting...");

        if (this.device === null) {
            this.device = await navigator.serial.requestPort({});
            this.transport = new Transport(this.device, true);
        }

        const espLoaderTerminal = {
            clean() {
                // Clear the terminal
            },
            writeLine(data) {
                logger.log(data);
            },
            write(data) {
                logger.log(data);
            },
        };

        const loaderOptions = {
            transport: this.transport,
            baudrate: this.baudRate,
            terminal: espLoaderTerminal,
            debugLogging: false,
        };

        this.esploader = new ESPLoader(loaderOptions);
        this.chip = await this.esploader.main();

        logger.log("Connected successfully.");

        return this.esploader;
    };
}