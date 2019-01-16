const logger = require('../util/logger');
const settings = require('../util/settings');
const utils = require('../util/utils');
const Queue = require('queue');

/**
 * This extensions set availability based on optionally polling router devices
 * and optionally check device publish with attribute reporting
 */
class DeviceAvailabilityHandler {
    constructor(zigbee, mqtt, state, publishDeviceState) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.state = state;
        this.availability_timeout = settings.get().experimental.availability_timeout;
        this.timers = {};
        this.pending = [];

        /**
         * Setup command queue.
         * The command queue ensures that only 1 command is executed at a time.
         * This is to avoid DDoSiNg of the coordinator.
         */
        this.queue = new Queue();
        this.queue.concurrency = 1;
        this.queue.autostart = true;
    }

    isPingable(device) {
        return ( (device.type === 'Router' && device.powerSource && device.powerSource !== 'Battery') ||
                 (device.manufId === 4448 && device.modelId === 'E11-G13') );
    }

    getAllPingableDevices() {
        return this.zigbee.getAllClients().filter((d) => this.isPingable(d));
    }

    onMQTTConnected() {
        // As some devices are not checked for availability (e.g. battery powered devices)
        // we mark all device as online by default.
        this.zigbee.getDevices()
            .filter((d) => d.type !== 'Coordinator')
            .forEach((device) => this.publishAvailability(device.ieeeAddr, true));

        // Start timers for all devices
        this.getAllPingableDevices().forEach((device) => this.setTimer(device.ieeeAddr));
    }

    handleInterval(ieeeAddr) {
        // Check if a job is already pending.
        // This avoids overflowing of the queue in case the queue is not able to catch-up with the jobs being added.
        if (this.pending.includes(ieeeAddr)) {
            logger.debug(`Skipping ping for ${ieeeAddr} becuase job is already in queue`);
            return;
        }

        this.pending.push(ieeeAddr);

        this.queue.push((queueCallback) => {
            this.zigbee.ping(ieeeAddr, (error) => {
                if (error) {
                    logger.debug(`Failed to ping ${ieeeAddr}`);
                } else {
                    logger.debug(`Sucesfully pinged ${ieeeAddr}`);
                }

                this.publishAvailability(ieeeAddr, !error);

                // Remove from pending jobs.
                const index = this.pending.indexOf(ieeeAddr);
                if (index !== -1) {
                    this.pending.splice(index, 1);
                }

                this.setTimer(ieeeAddr);
                queueCallback();
            });
        });
    }

    setTimer(ieeeAddr) {
        if (this.timers[ieeeAddr]) {
            clearTimeout(this.timers[ieeeAddr]);
        }

        this.timers[ieeeAddr] = setTimeout(() => {
            this.handleInterval(ieeeAddr);
        }, utils.secondsToMilliseconds(this.availability_timeout));
    }

    stop() {
        this.queue.stop();

        this.zigbee.getDevices()
            .filter((d) => d.type !== 'Coordinator')
            .forEach((device) => this.publishAvailability(device.ieeeAddr, false));
    }

    publishAvailability(ieeeAddr, available) {
        const deviceSettings = settings.getDevice(ieeeAddr);
        const name = deviceSettings ? deviceSettings.friendly_name : ieeeAddr;
        const topic = `${name}/availability`;
        const payload = available ? 'online' : 'offline';
        logger.debug(`Device information for ${ieeeAddr}: ` + JSON.stringify(deviceSettings));
        if (name && name === 'big_lamp') {
            logger.debug(`First info: ${ieeeAddr}: ` + JSON.stringify(this.state.get(ieeeAddr)));
            //this.state.set(ieeeAddr, messagePayload);
            const device = this.zigbee.shepherd.find(ieeeAddr, 1);
            if (device) {
                logger.debug(`Second info: ${ieeeAddr}: ` + device.getDevice().status);
                /*device.getDevice().update({
                    status: 'on',
                });*/
            }
        }
        this.mqtt.publish(topic, payload, {retain: true, qos: 0});
    }

    stringifyOnce(obj, replacer, indent) {
        var printedObjects = [];
        var printedObjectKeys = [];
    
        function printOnceReplacer(key, value){
            if ( printedObjects.length > 2000){ // browsers will not print more than 20K, I don't see the point to allow 2K.. algorithm will not be fast anyway if we have too many objects
            return 'object too long';
            }
            var printedObjIndex = false;
            printedObjects.forEach(function(obj, index){
                if(obj===value){
                    printedObjIndex = index;
                }
            });
    
            if ( key == ''){ //root element
                 printedObjects.push(obj);
                printedObjectKeys.push("root");
                 return value;
            }
    
            else if(printedObjIndex+"" != "false" && typeof(value)=="object"){
                if ( printedObjectKeys[printedObjIndex] == "root"){
                    return "(pointer to root)";
                }else{
                    return "(see " + ((!!value && !!value.constructor) ? value.constructor.name.toLowerCase()  : typeof(value)) + " with key " + printedObjectKeys[printedObjIndex] + ")";
                }
            }else{
    
                var qualifiedKey = key || "(empty key)";
                printedObjects.push(value);
                printedObjectKeys.push(qualifiedKey);
                if(replacer){
                    return replacer(key, value);
                }else{
                    return value;
                }
            }
        }
        return JSON.stringify(obj, printOnceReplacer, indent);
    };

    onZigbeeMessage(message, device, mappedDevice) {
        // When a zigbee message from a device is received we know the device is still alive.
        // => reset the timer.
        if (device && this.isPingable(this.zigbee.getDevice(device.ieeeAddr))) {
            this.setTimer(device.ieeeAddr);
        }
    }
}

module.exports = DeviceAvailabilityHandler;
