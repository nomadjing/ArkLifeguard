/** Known registration families without a dedicated identity/cancellation summary.
 * This is a coverage catalog, not an executable fallback matcher.
 */
export const UNSUPPORTED_REGISTRATION_API_FAMILIES: readonly string[] = Object.freeze([
    'sensor.on',
    'geoLocationManager.on',
    'worker.onmessage',
    'AbilityContext.on',
    'inputMethodController.on',
    'displaySync.on',
    'CommonEventManager.subscribe',
]);
