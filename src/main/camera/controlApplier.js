/** Dispatches a validated (control, value) pair to the right CameraClient method. Port of ControlApplier.php. */
function apply(client, control, value) {
    switch (control) {
        case 'tally':
            return client.setTally(Boolean(value));
        case 'awb_mode':
            return client.setAwbMode(Number(value));
        case 'wb_r':
            return client.setWbRedGain(Number(value));
        case 'wb_b':
            return client.setWbBlueGain(Number(value));
        case 'iris':
            return client.setIris(Number(value));
        case 'auto_iris':
            return client.setAutoIris(Boolean(value));
        case 'iris_level':
            return client.setIrisLevel(Number(value));
        case 'zoom':
            return client.setZoomSpeed(Number(value));
        case 'focus':
            return client.setFocusSpeed(Number(value));
        case 'auto_focus':
            return client.setAutoFocus(Boolean(value));
        case 'trigger_awb':
            return client.triggerAwb();
        default:
            throw new Error(`No handler for control '${control}'`);
    }
}

module.exports = { apply };
