// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// Names for display: MCUs, boards, firmware, services and addresses.

import { SERVICES, VALUES } from '../../js/messages.js';
import { mcuName } from '../../js/target-state.js';

export {
    MODELS, boardName, firmwareName, firmwareState, ipv4, ipv6, isZero, macText, signalBars, sizeText,
    targetState, modelName, versionText,
} from '../../js/setup/format.js';

export { mcuName };

/** @returns {string} the MCU's name, the TARGETID in hex, or Unknown */
export function describeMcu(targetid) {
    if (!targetid) {
        return VALUES.UNKNOWN;
    }
    return mcuName(targetid) ?? VALUES.TARGET_MCU(targetid.toString(16).padStart(8, '0'));
}

/**
 * @param {Array<{service: number, operation: number}>} services - TARGET's
 * @returns {Array<{text: string, description: string|null}>} one per
 *          service, with its operations where Airfrog supports only some of
 *          them, and its description
 */
export function describeServices(services) {
    const byService = new Map();
    for (const { service, operation } of services) {
        if (!byService.has(service)) {
            byService.set(service, []);
        }
        byService.get(service).push(operation);
    }
    return [...byService].map(([service, operations]) => {
        const known = SERVICES[service];
        const name = known?.name ?? VALUES.SERVICE(service);
        const description = known?.description ?? null;
        if (operations.includes(0)) {
            return { text: name, description };
        }
        const ops = operations.map(op => known?.operations[op] ?? VALUES.OPERATION(op));
        return { text: `${name}: ${ops.join(', ')}`, description };
    });
}

/** @returns {Array<string>} describeServices()'s texts */
export function serviceNames(services) {
    return describeServices(services).map(s => s.text);
}
