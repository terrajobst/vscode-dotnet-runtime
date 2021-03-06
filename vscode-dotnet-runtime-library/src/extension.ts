/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as cp from 'child_process';
import * as fs from 'fs';
import open = require('open');
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AcquisitionInvoker } from './Acquisition/AcquisitionInvoker';
import { DotnetCoreAcquisitionWorker } from './Acquisition/DotnetCoreAcquisitionWorker';
import { DotnetCoreDependencyInstaller } from './Acquisition/DotnetCoreDependencyInstaller';
import { InstallationValidator } from './Acquisition/InstallationValidator';
import { VersionResolver } from './Acquisition/VersionResolver';
import { EventStream } from './EventStream/EventStream';
import { DotnetAcquisitionMissingLinuxDependencies } from './EventStream/EventStreamEvents';
import { IEventStreamObserver } from './EventStream/IEventStreamObserver';
import { LoggingObserver } from './EventStream/LoggingObserver';
import { OutputChannelObserver } from './EventStream/OutputChannelObserver';
import { StatusBarObserver } from './EventStream/StatusBarObserver';
import { TelemetryObserver } from './EventStream/TelemetryObserver';
import { IDotnetAcquireContext } from './IDotnetAcquireContext';
import { IDotnetAcquireResult } from './IDotnetAcquireResult';
import { IDotnetEnsureDependenciesContext } from './IDotnetEnsureDependenciesContext';
import { IExtensionContext } from './IExtensionContext';
import { callWithErrorHandling } from './Utils/ErrorHandler';
import { formatIssueUrl } from './Utils/IssueReporter';

export function activate(context: vscode.ExtensionContext, parentExtensionId: string, extensionContext?: IExtensionContext) {
    const extension = vscode.extensions.getExtension(parentExtensionId);

    if (!extension) {
        throw new Error(`Could not resolve dotnet acquisition extension '${parentExtensionId}' location`);
    }

    const outputChannel = vscode.window.createOutputChannel('.NET Core Tooling');
    if (!fs.existsSync(context.logPath)) {
        fs.mkdirSync(context.logPath);
    }
    const logFile = path.join(context.logPath, `DotNetAcquisition${ new Date().getTime() }.txt`);
    const loggingObserver = new LoggingObserver(logFile);
    let eventStreamObservers: IEventStreamObserver[] =
        [
            new StatusBarObserver(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, Number.MIN_VALUE)),
            new OutputChannelObserver(outputChannel),
            loggingObserver,
        ];
    if (enableTelemetry()) {
        eventStreamObservers = eventStreamObservers.concat(new TelemetryObserver(extensionContext ? extensionContext.telemetryReporter : undefined));
    }
    const eventStream = new EventStream();

    for (const observer of eventStreamObservers) {
        eventStream.subscribe(event => observer.post(event));
    }

    const issueContext = { logger: loggingObserver };

    if (!fs.existsSync(context.globalStoragePath)) {
        fs.mkdirSync(context.globalStoragePath);
    }
    const acquisitionWorker = new DotnetCoreAcquisitionWorker({
        storagePath: context.globalStoragePath,
        extensionState: context.globalState,
        eventStream,
        acquisitionInvoker: new AcquisitionInvoker(context.globalState, eventStream),
        versionResolver: new VersionResolver(context.globalState, eventStream),
        installationValidator: new InstallationValidator(eventStream),
    });

    const dotnetAcquireRegistration = vscode.commands.registerCommand('dotnet.acquire', async (commandContext: IDotnetAcquireContext) => {
        const dotnetPath = await callWithErrorHandling<Promise<IDotnetAcquireResult>>(async () => {
            if (!commandContext.version || commandContext.version === 'latest') {
                throw new Error(`Cannot acquire .NET Core version "${commandContext.version}". Please provide a valid version.`);
            }
            return acquisitionWorker.acquire(commandContext.version);
        }, issueContext);
        return dotnetPath;
    });
    const dotnetUninstallAllRegistration = vscode.commands.registerCommand('dotnet.uninstallAll', async () => {
        await callWithErrorHandling(() => acquisitionWorker.uninstallAll(), issueContext);
    });
    const showOutputChannelRegistration = vscode.commands.registerCommand('dotnet.showAcquisitionLog', () => outputChannel.show(/* preserveFocus */ false));
    const testApplicationRegistration = vscode.commands.registerCommand('dotnet.ensureDotnetDependencies', async (commandContext: IDotnetEnsureDependenciesContext) => {
        await callWithErrorHandling(async () => {
            if (os.platform() !== 'linux') {
                // We can't handle installing dependencies for anything other than Linux
                return;
            }

            const result = cp.spawnSync(commandContext.command, commandContext.arguments);
            const installer = new DotnetCoreDependencyInstaller();
            if (installer.signalIndicatesMissingLinuxDependencies(result.signal)) {
                eventStream.post(new DotnetAcquisitionMissingLinuxDependencies());
                await installer.promptLinuxDependencyInstall('Failed to run .NET tooling.');
            }
        }, issueContext);
    });
    const reportIssueRegistration = vscode.commands.registerCommand('dotnet.reportIssue', async () => {
        const [url, issueBody] = formatIssueUrl(undefined, issueContext);
        await vscode.env.clipboard.writeText(issueBody);
        open(url);
    });

    context.subscriptions.push(
        dotnetAcquireRegistration,
        dotnetUninstallAllRegistration,
        showOutputChannelRegistration,
        testApplicationRegistration,
        reportIssueRegistration);

    context.subscriptions.push({
        dispose: () => {
            for (const observer of eventStreamObservers) {
                observer.dispose();
            }
        },
    });
}

function enableTelemetry(): boolean {
    const extensionTelemetry: boolean | undefined = vscode.workspace.getConfiguration('dotnetAcquisitionExtension').get('enableTelemetry');
    const vscodeTelemetry: boolean | undefined = vscode.workspace.getConfiguration('telemetry').get('enableTelemetry');
    const enableDotnetTelemetry = extensionTelemetry === undefined ? true : extensionTelemetry;
    const enableVSCodeTelemetry = vscodeTelemetry === undefined ? true : vscodeTelemetry;
    return enableVSCodeTelemetry && enableDotnetTelemetry;
}
