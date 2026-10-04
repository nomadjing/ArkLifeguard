/** Known API families outside the default resource contracts. No fallback is applied. */
export const UNSUPPORTED_RESOURCE_API_FAMILIES: readonly string[] = Object.freeze([
    'media.createAVRecorder',
    'media.createVideoPlayer',
    'media.createAudioPlayer',
    'socket.constructTCPSocketInstance',
    'socket.constructUDPSocketInstance',
    'webSocket.createWebSocket',
    'RdbStore ownership (getRdbStore)',
    '@ohos.data.rdb ResultSet',
    'backgroundTaskManager.requestSuspendDelay',
    'workScheduler.startWork',
    'CameraManager.createCaptureSession',
    'CameraManager.createCameraInput',
    'Worker/ThreadWorker termination',
]);
