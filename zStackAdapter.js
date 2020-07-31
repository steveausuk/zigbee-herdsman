"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const tstype_1 = require("./tstype");
const Events = __importStar(require("../../events"));
const adapter_1 = __importDefault(require("../../adapter"));
const znp_1 = require("../znp");
const startZnp_1 = __importDefault(require("./startZnp"));
const unpi_1 = require("../unpi");
const zcl_1 = require("../../../zcl");
const utils_1 = require("../../../utils");
const Constants = __importStar(require("../constants"));
const debug_1 = __importDefault(require("debug"));
const backup_1 = require("./backup");
const debug = debug_1.default("zigbee-herdsman:adapter:zStack:adapter");
const Subsystem = unpi_1.Constants.Subsystem;
const Type = unpi_1.Constants.Type;
const { ZnpCommandStatus, AddressMode } = Constants.COMMON;
const DataConfirmErrorCodeLookup = {
    183: 'APS no ack',
    205: 'No network route',
    225: 'MAC channel access failure',
    233: 'MAC no ack',
    240: 'MAC transaction expired',
};
class DataConfirmError extends Error {
    constructor(code) {
        const message = `Data request failed with error: '${DataConfirmErrorCodeLookup[code]}' (${code})`;
        super(message);
        this.code = code;
    }
}
class ZStackAdapter extends adapter_1.default {
    constructor(networkOptions, serialPortOptions, backupPath, adapterOptions) {
        super(networkOptions, serialPortOptions, backupPath, adapterOptions);
        this.znp = new znp_1.Znp(this.serialPortOptions.path, this.serialPortOptions.baudRate, this.serialPortOptions.rtscts);
        this.transactionID = 0;
        this.closing = false;
        this.waitress = new utils_1.Waitress(this.waitressValidator, this.waitressTimeoutFormatter);
        this.znp.on('received', this.onZnpRecieved.bind(this));
        this.znp.on('close', this.onZnpClose.bind(this));
    }
    /**
     * Adapter methods
     */
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.znp.open();
            const attempts = 3;
            for (let i = 0; i < attempts; i++) {
                try {
                    yield this.znp.request(Subsystem.SYS, 'ping', { capabilities: 1 });
                    break;
                }
                catch (e) {
                    if (attempts - 1 === i) {
                        throw new Error(`Failed to connect to the adapter (${e})`);
                    }
                }
            }
            // Old firmware did not support version, assume it's Z-Stack 1.2 for now.
            try {
                this.version = (yield this.znp.request(Subsystem.SYS, 'version', {})).payload;
            }
            catch (e) {
                debug(`Failed to get zStack version, assuming 1.2`);
                this.version = { "transportrev": 2, "product": 0, "majorrel": 2, "minorrel": 0, "maintrel": 0, "revision": "" };
            }
            const concurrent = this.adapterOptions && this.adapterOptions.concurrent ?
                this.adapterOptions.concurrent :
                (this.version.product === tstype_1.ZnpVersion.zStack3x0 ? 16 : 2);
            debug(`Adapter concurrent: ${concurrent}`);
            this.queue = new utils_1.Queue(concurrent);
            debug(`Detected znp version '${tstype_1.ZnpVersion[this.version.product]}' (${JSON.stringify(this.version)})`);
            return startZnp_1.default(this.znp, this.version.product, this.networkOptions, this.greenPowerGroup, this.backupPath);
        });
    }
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            this.closing = true;
            yield this.znp.close();
        });
    }
    static isValidPath(path) {
        return __awaiter(this, void 0, void 0, function* () {
            return znp_1.Znp.isValidPath(path);
        });
    }
    static autoDetectPath() {
        return __awaiter(this, void 0, void 0, function* () {
            return znp_1.Znp.autoDetectPath();
        });
    }
    getCoordinator() {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                const activeEpRsp = this.znp.waitFor(unpi_1.Constants.Type.AREQ, Subsystem.ZDO, 'activeEpRsp');
                yield this.znp.request(Subsystem.ZDO, 'activeEpReq', { dstaddr: 0, nwkaddrofinterest: 0 }, activeEpRsp.ID);
                const activeEp = yield activeEpRsp.start().promise;
                const deviceInfo = yield this.znp.request(Subsystem.UTIL, 'getDeviceInfo', {});
                const endpoints = [];
                for (const endpoint of activeEp.payload.activeeplist) {
                    const simpleDescRsp = this.znp.waitFor(unpi_1.Constants.Type.AREQ, Subsystem.ZDO, 'simpleDescRsp', { endpoint });
                    yield this.znp.request(Subsystem.ZDO, 'simpleDescReq', { dstaddr: 0, nwkaddrofinterest: 0, endpoint }, simpleDescRsp.ID);
                    const simpleDesc = yield simpleDescRsp.start().promise;
                    endpoints.push({
                        ID: simpleDesc.payload.endpoint,
                        profileID: simpleDesc.payload.profileid,
                        deviceID: simpleDesc.payload.deviceid,
                        inputClusters: simpleDesc.payload.inclusterlist,
                        outputClusters: simpleDesc.payload.outclusterlist,
                    });
                }
                return {
                    networkAddress: 0,
                    manufacturerID: 0,
                    ieeeAddr: deviceInfo.payload.ieeeaddr,
                    endpoints,
                };
            }));
        });
    }
    permitJoin(seconds, networkAddress) {
        return __awaiter(this, void 0, void 0, function* () {
            const addrmode = networkAddress === null ? 0x0F : 0x02;
            const dstaddr = networkAddress || 0xFFFC;
            yield this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                const payload = { addrmode, dstaddr, duration: seconds, tcsignificance: 0 };
                yield this.znp.request(Subsystem.ZDO, 'mgmtPermitJoinReq', payload);
            }));
        });
    }
    getCoordinatorVersion() {
        return __awaiter(this, void 0, void 0, function* () {
            return { type: tstype_1.ZnpVersion[this.version.product], meta: this.version };
        });
    }
    reset(type) {
        return __awaiter(this, void 0, void 0, function* () {
            if (type === 'soft') {
                yield this.znp.request(Subsystem.SYS, 'resetReq', { type: Constants.SYS.resetType.SOFT });
            }
            else {
                yield this.znp.request(Subsystem.SYS, 'resetReq', { type: Constants.SYS.resetType.HARD });
            }
        });
    }
    supportsLED() {
        return __awaiter(this, void 0, void 0, function* () {
            return this.version.product !== tstype_1.ZnpVersion.zStack3x0;
        });
    }
    setLED(enabled) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.znp.request(Subsystem.UTIL, 'ledControl', { ledid: 3, mode: enabled ? 1 : 0 });
        });
    }
    discoverRoute(networkAddress) {
        return __awaiter(this, void 0, void 0, function* () {
            const payload = { dstAddr: networkAddress, options: 0, radius: Constants.AF.DEFAULT_RADIUS };
            debug('Discovering route to %d', networkAddress);
            yield this.znp.request(Subsystem.ZDO, 'extRouteDisc', payload);
            yield utils_1.Wait(3000);
        });
    }
    nodeDescriptor(networkAddress) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                try {
                    const result = yield this.nodeDescriptorInternal(networkAddress);
                    return result;
                }
                catch (error) {
                    debug(`Node descriptor request for '${networkAddress}' failed (${error}), retry`);
                    // Doing a route discovery after simple descriptor request fails makes it succeed sometimes.
                    // https://github.com/Koenkk/zigbee2mqtt/issues/3276
                    yield this.discoverRoute(networkAddress);
                    const result = yield this.nodeDescriptorInternal(networkAddress);
                    return result;
                }
            }), networkAddress);
        });
    }
    nodeDescriptorInternal(networkAddress) {
        return __awaiter(this, void 0, void 0, function* () {
            const response = this.znp.waitFor(Type.AREQ, Subsystem.ZDO, 'nodeDescRsp', { nwkaddr: networkAddress });
            const payload = { dstaddr: networkAddress, nwkaddrofinterest: networkAddress };
            yield this.znp.request(Subsystem.ZDO, 'nodeDescReq', payload, response.ID);
            const descriptor = yield response.start().promise;
            let type = 'Unknown';
            const logicalType = descriptor.payload.logicaltype_cmplxdescavai_userdescavai & 0x07;
            for (const [key, value] of Object.entries(Constants.ZDO.deviceLogicalType)) {
                if (value === logicalType) {
                    if (key === 'COORDINATOR')
                        type = 'Coordinator';
                    else if (key === 'ROUTER')
                        type = 'Router';
                    else if (key === 'ENDDEVICE')
                        type = 'EndDevice';
                    break;
                }
            }
            return { manufacturerCode: descriptor.payload.manufacturercode, type };
        });
    }
    activeEndpoints(networkAddress) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                const response = this.znp.waitFor(Type.AREQ, Subsystem.ZDO, 'activeEpRsp', { nwkaddr: networkAddress });
                const payload = { dstaddr: networkAddress, nwkaddrofinterest: networkAddress };
                yield this.znp.request(Subsystem.ZDO, 'activeEpReq', payload, response.ID);
                const activeEp = yield response.start().promise;
                return { endpoints: activeEp.payload.activeeplist };
            }), networkAddress);
        });
    }
    simpleDescriptor(networkAddress, endpointID) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                const responsePayload = { nwkaddr: networkAddress, endpoint: endpointID };
                const response = this.znp.waitFor(Type.AREQ, Subsystem.ZDO, 'simpleDescRsp', responsePayload);
                const payload = { dstaddr: networkAddress, nwkaddrofinterest: networkAddress, endpoint: endpointID };
                yield this.znp.request(Subsystem.ZDO, 'simpleDescReq', payload, response.ID);
                const descriptor = yield response.start().promise;
                return {
                    profileID: descriptor.payload.profileid,
                    endpointID: descriptor.payload.endpoint,
                    deviceID: descriptor.payload.deviceid,
                    inputClusters: descriptor.payload.inclusterlist,
                    outputClusters: descriptor.payload.outclusterlist,
                };
            }), networkAddress);
        });
    }
    sendZclFrameToEndpoint(networkAddress, endpoint, zclFrame, timeout, disableResponse, sourceEndpoint) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                return this.sendZclFrameToEndpointInternal(networkAddress, endpoint, sourceEndpoint || 1, zclFrame, timeout, disableResponse, true);
            }), networkAddress);
        });
    }
    sendZclFrameToEndpointInternal(networkAddress, endpoint, sourceEndpoint, zclFrame, timeout, disableResponse, firstAttempt) {
        return __awaiter(this, void 0, void 0, function* () {
            let response = null;
            const command = zclFrame.getCommand();
            if (command.hasOwnProperty('response') && disableResponse === false) {
                response = this.waitForInternal(networkAddress, endpoint, zclFrame.Header.frameControl.frameType, zcl_1.Direction.SERVER_TO_CLIENT, zclFrame.Header.transactionSequenceNumber, zclFrame.Cluster.ID, command.response, timeout);
            }
            else if (!zclFrame.Header.frameControl.disableDefaultResponse) {
                response = this.waitForInternal(networkAddress, endpoint, zcl_1.FrameType.GLOBAL, zcl_1.Direction.SERVER_TO_CLIENT, zclFrame.Header.transactionSequenceNumber, zclFrame.Cluster.ID, zcl_1.Foundation.defaultRsp.ID, timeout);
            }
            try {
                yield this.dataRequest(networkAddress, endpoint, sourceEndpoint, zclFrame.Cluster.ID, Constants.AF.DEFAULT_RADIUS, zclFrame.toBuffer(), timeout - 1000, 5);
            }
            catch (error) {
                if (response) {
                    response.cancel();
                }
                throw error;
            }
            if (response !== null) {
                try {
                    const result = yield response.start().promise;
                    return result;
                }
                catch (error) {
                    if (firstAttempt) {
                        // Timeout could happen because of invalid route, rediscover and retry.
                        yield this.discoverRoute(networkAddress);
                        return this.sendZclFrameToEndpointInternal(networkAddress, endpoint, sourceEndpoint, zclFrame, timeout, disableResponse, false);
                    }
                    else {
                        throw error;
                    }
                }
            }
            else {
                return null;
            }
        });
    }
    sendZclFrameToGroup(groupID, zclFrame, sourceEndpoint) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                yield this.dataRequestExtended(AddressMode.ADDR_GROUP, groupID, 0xFF, 0, sourceEndpoint || 1, zclFrame.Cluster.ID, Constants.AF.DEFAULT_RADIUS, zclFrame.toBuffer(), 3000, true);
                /**
                 * As a group command is not confirmed and thus immidiately returns
                 * (contrary to network address requests) we will give the
                 * command some time to 'settle' in the network.
                 */
                yield utils_1.Wait(200);
            }));
        });
    }
    sendZclFrameToAll(endpoint, zclFrame, sourceEndpoint) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                yield this.dataRequestExtended(AddressMode.ADDR_16BIT, 0xFFFD, endpoint, 0, sourceEndpoint, zclFrame.Cluster.ID, Constants.AF.DEFAULT_RADIUS, zclFrame.toBuffer(), 3000, false, 0);
                /**
                 * As a broadcast command is not confirmed and thus immidiately returns
                 * (contrary to network address requests) we will give the
                 * command some time to 'settle' in the network.
                 */
                yield utils_1.Wait(200);
            }));
        });
    }
    lqi(networkAddress) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                const neighbors = [];
                // eslint-disable-next-line
                const request = (startIndex) => __awaiter(this, void 0, void 0, function* () {
                    const response = this.znp.waitFor(Type.AREQ, Subsystem.ZDO, 'mgmtLqiRsp', { srcaddr: networkAddress });
                    yield this.znp.request(Subsystem.ZDO, 'mgmtLqiReq', { dstaddr: networkAddress, startindex: startIndex }, response.ID);
                    const result = yield response.start().promise;
                    if (result.payload.status !== ZnpCommandStatus.SUCCESS) {
                        throw new Error(`LQI for '${networkAddress}' failed`);
                    }
                    return result;
                });
                // eslint-disable-next-line
                const add = (list) => {
                    for (const entry of list) {
                        neighbors.push({
                            linkquality: entry.lqi,
                            networkAddress: entry.nwkAddr,
                            ieeeAddr: entry.extAddr,
                            relationship: entry.relationship,
                            depth: entry.depth,
                        });
                    }
                };
                let response = yield request(0);
                add(response.payload.neighborlqilist);
                const size = response.payload.neighbortableentries;
                let nextStartIndex = response.payload.neighborlqilist.length;
                while (neighbors.length < size) {
                    response = yield request(nextStartIndex);
                    add(response.payload.neighborlqilist);
                    nextStartIndex += response.payload.neighborlqilist.length;
                }
                return { neighbors };
            }), networkAddress);
        });
    }
    routingTable(networkAddress) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                const table = [];
                // eslint-disable-next-line
                const request = (startIndex) => __awaiter(this, void 0, void 0, function* () {
                    const response = this.znp.waitFor(Type.AREQ, Subsystem.ZDO, 'mgmtRtgRsp', { srcaddr: networkAddress });
                    yield this.znp.request(Subsystem.ZDO, 'mgmtRtgReq', { dstaddr: networkAddress, startindex: startIndex }, response.ID);
                    const result = yield response.start().promise;
                    if (result.payload.status !== ZnpCommandStatus.SUCCESS) {
                        throw new Error(`Routing table for '${networkAddress}' failed`);
                    }
                    return result;
                });
                // eslint-disable-next-line
                const add = (list) => {
                    for (const entry of list) {
                        table.push({
                            destinationAddress: entry.destNwkAddr,
                            status: entry.routeStatus,
                            nextHop: entry.nextHopNwkAddr,
                        });
                    }
                };
                let response = yield request(0);
                add(response.payload.routingtablelist);
                const size = response.payload.routingtableentries;
                let nextStartIndex = response.payload.routingtablelist.length;
                while (table.length < size) {
                    response = yield request(nextStartIndex);
                    add(response.payload.routingtablelist);
                    nextStartIndex += response.payload.routingtablelist.length;
                }
                return { table };
            }), networkAddress);
        });
    }
    bind(destinationNetworkAddress, sourceIeeeAddress, sourceEndpoint, clusterID, destinationAddressOrGroup, type, destinationEndpoint) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                const responsePayload = { srcaddr: destinationNetworkAddress };
                const response = this.znp.waitFor(Type.AREQ, Subsystem.ZDO, 'bindRsp', responsePayload);
                const payload = {
                    dstaddr: destinationNetworkAddress,
                    srcaddr: sourceIeeeAddress,
                    srcendpoint: sourceEndpoint,
                    clusterid: clusterID,
                    dstaddrmode: type === 'group' ?
                        AddressMode.ADDR_GROUP : AddressMode.ADDR_64BIT,
                    dstaddress: this.toAddressString(destinationAddressOrGroup),
                    dstendpoint: type === 'group' ? 0xFF : destinationEndpoint,
                };
                yield this.znp.request(Subsystem.ZDO, 'bindReq', payload, response.ID);
                yield response.start().promise;
            }), destinationNetworkAddress);
        });
    }
    unbind(destinationNetworkAddress, sourceIeeeAddress, sourceEndpoint, clusterID, destinationAddressOrGroup, type, destinationEndpoint) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                const response = this.znp.waitFor(Type.AREQ, Subsystem.ZDO, 'unbindRsp', { srcaddr: destinationNetworkAddress });
                const payload = {
                    dstaddr: destinationNetworkAddress,
                    srcaddr: sourceIeeeAddress,
                    srcendpoint: sourceEndpoint,
                    clusterid: clusterID,
                    dstaddrmode: type === 'group' ?
                        AddressMode.ADDR_GROUP : AddressMode.ADDR_64BIT,
                    dstaddress: this.toAddressString(destinationAddressOrGroup),
                    dstendpoint: type === 'group' ? 0xFF : destinationEndpoint,
                };
                yield this.znp.request(Subsystem.ZDO, 'unbindReq', payload, response.ID);
                yield response.start().promise;
            }), destinationNetworkAddress);
        });
    }
    removeDevice(networkAddress, ieeeAddr) {
        return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
            const response = this.znp.waitFor(unpi_1.Constants.Type.AREQ, Subsystem.ZDO, 'mgmtLeaveRsp', { srcaddr: networkAddress });
            const payload = {
                dstaddr: networkAddress,
                deviceaddress: ieeeAddr,
                removechildrenRejoin: 0,
            };
            yield this.znp.request(Subsystem.ZDO, 'mgmtLeaveReq', payload, response.ID);
            yield response.start().promise;
        }), networkAddress);
    }
    /**
     * Event handlers
     */
    onZnpClose() {
        if (!this.closing) {
            this.emit(Events.Events.disconnected);
        }
    }
    onZnpRecieved(object) {
        if (object.type !== unpi_1.Constants.Type.AREQ) {
            return;
        }
        if (object.subsystem === Subsystem.ZDO) {
            if (object.command === 'tcDeviceInd') {
                const payload = {
                    networkAddress: object.payload.nwkaddr,
                    ieeeAddr: object.payload.extaddr,
                };
                this.emit(Events.Events.deviceJoined, payload);
            }
            else if (object.command === 'endDeviceAnnceInd') {
                const payload = {
                    networkAddress: object.payload.nwkaddr,
                    ieeeAddr: object.payload.ieeeaddr,
                };
                this.emit(Events.Events.deviceAnnounce, payload);
            }
            else {
                /* istanbul ignore else */
                if (object.command === 'leaveInd') {
                    const payload = {
                        networkAddress: object.payload.srcaddr,
                        ieeeAddr: object.payload.extaddr,
                    };
                    this.emit(Events.Events.deviceLeave, payload);
                }
            }
        }
        else {
            /* istanbul ignore else */
            if (object.subsystem === Subsystem.AF) {
                /* istanbul ignore else */
                if (object.command === 'incomingMsg' || object.command === 'incomingMsgExt') {
                    try {
                        const payload = {
                            frame: zcl_1.ZclFrame.fromBuffer(object.payload.clusterid, object.payload.data),
                            address: object.payload.srcaddr,
                            endpoint: object.payload.srcendpoint,
                            linkquality: object.payload.linkquality,
                            groupID: object.payload.groupid,
                        };
                        this.waitress.resolve(payload);
                        this.emit(Events.Events.zclData, payload);
                    }
                    catch (error) {
                        const payload = {
                            clusterID: object.payload.clusterid,
                            data: object.payload.data,
                            address: object.payload.srcaddr,
                            endpoint: object.payload.srcendpoint,
                            linkquality: object.payload.linkquality,
                            groupID: object.payload.groupid,
                        };
                        this.emit(Events.Events.rawData, payload);
                    }
                }
            }
        }
    }
    getNetworkParameters() {
        return __awaiter(this, void 0, void 0, function* () {
            const result = yield this.znp.request(Subsystem.ZDO, 'extNwkInfo', {});
            return {
                panID: result.payload.panid, extendedPanID: result.payload.extendedpanid,
                channel: result.payload.channel
            };
        });
    }
    supportsBackup() {
        return __awaiter(this, void 0, void 0, function* () {
            return this.version.product !== tstype_1.ZnpVersion.zStack12;
        });
    }
    backup() {
        return __awaiter(this, void 0, void 0, function* () {
            return backup_1.Backup(this.znp);
        });
    }
    setChannelInterPAN(channel) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                yield this.znp.request(Subsystem.AF, 'interPanCtl', { cmd: 1, data: [channel] });
                // Make sure that endpoint 12 is registered to proxy the InterPAN messages.
                yield this.znp.request(Subsystem.AF, 'interPanCtl', { cmd: 2, data: [12] });
            }));
        });
    }
    sendZclFrameInterPANToIeeeAddr(zclFrame, ieeeAddr) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                yield this.dataRequestExtended(AddressMode.ADDR_64BIT, ieeeAddr, 0xFE, 0xFFFF, 12, zclFrame.Cluster.ID, 30, zclFrame.toBuffer(), 10000, false);
            }));
        });
    }
    sendZclFrameInterPANBroadcast(zclFrame, timeout) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                const command = zclFrame.getCommand();
                if (!command.hasOwnProperty('response')) {
                    throw new Error(`Command '${command.name}' has no response, cannot wait for response`);
                }
                const response = this.waitForInternal(null, 0xFE, zclFrame.Header.frameControl.frameType, zcl_1.Direction.SERVER_TO_CLIENT, null, zclFrame.Cluster.ID, command.response, timeout);
                try {
                    yield this.dataRequestExtended(AddressMode.ADDR_16BIT, 0xFFFF, 0xFE, 0xFFFF, 12, zclFrame.Cluster.ID, 30, zclFrame.toBuffer(), 10000, false);
                }
                catch (error) {
                    response.cancel();
                    throw error;
                }
                return response.start().promise;
            }));
        });
    }
    restoreChannelInterPAN() {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                yield this.znp.request(Subsystem.AF, 'interPanCtl', { cmd: 0, data: [] });
                // Give adapter some time to restore, otherwise stuff crashes
                yield utils_1.Wait(1000);
            }));
        });
    }
    setTransmitPower(value) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.queue.execute(() => __awaiter(this, void 0, void 0, function* () {
                yield this.znp.request(Subsystem.SYS, 'stackTune', { operation: 0, value });
            }));
        });
    }
    waitForInternal(networkAddress, endpoint, frameType, direction, transactionSequenceNumber, clusterID, commandIdentifier, timeout) {
        const payload = {
            address: networkAddress, endpoint, clusterID, commandIdentifier, frameType, direction,
            transactionSequenceNumber,
        };
        const waiter = this.waitress.waitFor(payload, timeout);
        const cancel = () => this.waitress.remove(waiter.ID);
        return { start: waiter.start, cancel };
    }
    waitFor(networkAddress, endpoint, frameType, direction, transactionSequenceNumber, clusterID, commandIdentifier, timeout) {
        const waiter = this.waitForInternal(networkAddress, endpoint, frameType, direction, transactionSequenceNumber, clusterID, commandIdentifier, timeout);
        return { cancel: waiter.cancel, promise: waiter.start().promise };
    }
    /**
     * Private methods
     */
    dataRequest(destinationAddress, destinationEndpoint, sourceEndpoint, clusterID, radius, data, timeout, attemptsLeft) {
        return __awaiter(this, void 0, void 0, function* () {
            const transactionID = this.nextTransactionID();
            const response = this.znp.waitFor(Type.AREQ, Subsystem.AF, 'dataConfirm', { transid: transactionID }, timeout);
            yield this.znp.request(Subsystem.AF, 'dataRequest', {
                dstaddr: destinationAddress,
                destendpoint: destinationEndpoint,
                srcendpoint: sourceEndpoint,
                clusterid: clusterID,
                transid: transactionID,
                options: Constants.AF.options.DISCV_ROUTE,
                radius: radius,
                len: data.length,
                data: data,
            }, response.ID);
            const dataConfirm = yield response.start().promise;
            if (dataConfirm.payload.status !== ZnpCommandStatus.SUCCESS) {
                debug('Data confirm error (%d, %d, %d)', destinationAddress, dataConfirm.payload.status, attemptsLeft);
                if ([ZnpCommandStatus.MAC_CHANNEL_ACCESS_FAILURE, ZnpCommandStatus.MAC_TRANSACTION_EXPIRED]
                    .includes(dataConfirm.payload.status) && attemptsLeft > 0) {
                    /**
                     * MAC_CHANNEL_ACCESS_FAILURE: When many commands at once are executed we can end up in a MAC
                     * channel access failure error. This is because there is too much traffic on the network.
                     * Retry this command once after a cooling down period.
                     * MAC_TRANSACTION_EXPIRED: Mac layer is sleeping, try a few more times
                     */
                    yield utils_1.Wait(2000);
                    return this.dataRequest(destinationAddress, destinationEndpoint, sourceEndpoint, clusterID, radius, data, timeout, attemptsLeft - 1);
                }
                else if ([ZnpCommandStatus.NWK_NO_ROUTE, ZnpCommandStatus.MAC_NO_ACK]
                    .includes(dataConfirm.payload.status) && attemptsLeft > 0) {
                    // NWK_NO_ROUTE: no network route => rediscover route
                    // MAC_NO_ACK: route may be corrupted
                    yield this.discoverRoute(destinationAddress);
                    return this.dataRequest(destinationAddress, destinationEndpoint, sourceEndpoint, clusterID, radius, data, timeout, 0);
                }
                else {
                    throw new DataConfirmError(dataConfirm.payload.status);
                }
            }
            return dataConfirm;
        });
    }
    dataRequestExtended(addressMode, destinationAddressOrGroupID, destinationEndpoint, panID, sourceEndpoint, clusterID, radius, data, timeout, confirmation, attemptsLeft = 5) {
        return __awaiter(this, void 0, void 0, function* () {
            const transactionID = this.nextTransactionID();
            const response = confirmation ?
                this.znp.waitFor(Type.AREQ, Subsystem.AF, 'dataConfirm', { transid: transactionID }, timeout) : null;
            yield this.znp.request(Subsystem.AF, 'dataRequestExt', {
                dstaddrmode: addressMode,
                dstaddr: this.toAddressString(destinationAddressOrGroupID),
                destendpoint: destinationEndpoint,
                dstpanid: panID,
                srcendpoint: sourceEndpoint,
                clusterid: clusterID,
                transid: transactionID,
                options: 0,
                radius,
                len: data.length,
                data: data,
            }, response ? response.ID : null);
            if (confirmation) {
                const dataConfirm = yield response.start().promise;
                if (dataConfirm.payload.status !== ZnpCommandStatus.SUCCESS) {
                    if (dataConfirm.payload.status === ZnpCommandStatus.MAC_CHANNEL_ACCESS_FAILURE && attemptsLeft > 0) {
                        /**
                         * 225: When many commands at once are executed we can end up in a MAC channel access failure
                         * error. This is because there is too much traffic on the network.
                         * Retry this command once after a cooling down period.
                         */
                        yield utils_1.Wait(2000);
                        return this.dataRequestExtended(addressMode, destinationAddressOrGroupID, destinationEndpoint, panID, sourceEndpoint, clusterID, radius, data, timeout, confirmation, attemptsLeft - 1);
                    }
                    else {
                        throw new DataConfirmError(dataConfirm.payload.status);
                    }
                }
                return dataConfirm;
            }
        });
    }
    nextTransactionID() {
        this.transactionID++;
        if (this.transactionID > 255) {
            this.transactionID = 1;
        }
        return this.transactionID;
    }
    toAddressString(address) {
        if (typeof address === 'number') {
            let addressString = address.toString(16);
            for (let i = addressString.length; i < 16; i++) {
                addressString = '0' + addressString;
            }
            return `0x${addressString}`;
        }
        else {
            return address.toString();
        }
    }
    waitressTimeoutFormatter(matcher, timeout) {
        return `Timeout - ${matcher.address} - ${matcher.endpoint}` +
            ` - ${matcher.transactionSequenceNumber} - ${matcher.clusterID}` +
            ` - ${matcher.commandIdentifier} after ${timeout}ms`;
    }
    waitressValidator(payload, matcher) {
        const transactionSequenceNumber = payload.frame.Header.transactionSequenceNumber;
        return (!matcher.address || payload.address === matcher.address) &&
            payload.endpoint === matcher.endpoint &&
            (!matcher.transactionSequenceNumber || transactionSequenceNumber === matcher.transactionSequenceNumber) &&
            payload.frame.Cluster.ID === matcher.clusterID &&
            matcher.frameType === payload.frame.Header.frameControl.frameType &&
            matcher.commandIdentifier === payload.frame.Header.commandIdentifier &&
            matcher.direction === payload.frame.Header.frameControl.direction;
    }
}
exports.default = ZStackAdapter;
//# sourceMappingURL=zStackAdapter.js.map