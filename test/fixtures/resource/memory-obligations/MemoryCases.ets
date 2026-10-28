import image from '@ohos.multimedia.image';
import http from '@ohos.net.http';
class Owner {
    value?: image.PixelMap;
    onCreate(): void { this.value = image.createPixelMapSync(); }
    onDestroy(): void { this.value?.release(); }
}
class UserMemory { release(): void {} }
export class MemoryCases {
    static close(value: image.PixelMap): void { value.release(); }
    static aliasRelease(): void {
        const first = image.createPixelMapSync();
        const alias = first;
        MemoryCases.close(alias);
    }
    static wrongObject(): void {
        const first = image.createPixelMapSync();
        const second = image.createPixelMapSync();
        second.release();
    }
    static unreachableRelease(): void {
        const value = image.createPixelMapSync();
        throw new Error('before cleanup');
        value.release();
    }
    static overwritten(): void {
        let value = image.createPixelMapSync();
        value = image.createPixelMapSync();
        value.release();
    }
    static clearIsNotRelease(): void {
        let value: image.PixelMap | undefined = image.createPixelMapSync();
        value = undefined;
    }
    static lifecycleRelease(): void {
        const owner = new Owner(); owner.onCreate(); owner.onDestroy();
    }
    static lifecycleLeak(): void {
        const owner = new Owner(); owner.onCreate();
    }
    static async promiseRelease(): Promise<void> {
        const source = image.createImageSource('x');
        const pixel = await source.createPixelMap();
        pixel.release(); source.release();
    }
    static promiseThenRelease(): void {
        const source = image.createImageSource('x');
        source.createPixelMap().then(pixel => { pixel.release(); });
        source.release();
    }
    static conditionalRelease(flag: boolean): void {
        const pixel = image.createPixelMapSync();
        if (flag) pixel.release();
    }
    static releaseThrows(): void {
        const pixel = image.createPixelMapSync();
        try { pixel.release(); } catch (error) {}
    }
    static mixed(): void {
        const pixel = image.createPixelMapSync();
        const request = http.createHttp();
    }
    static userApi(): void { const value = new UserMemory(); }
}
