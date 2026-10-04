import http from '@ohos.net.http';
import fs from '@ohos.file.fs';
import fileio from '@ohos.fileio';
import image from '@ohos.multimedia.image';
import media from '@ohos.multimedia.media';
import audio from '@ohos.multimedia.audio';
import relationalStore from '@ohos.data.relationalStore';
export class PlatformCases {
    static httpLeak(): void { const h = http.createHttp();  }
    static httpRelease(): void { const h = http.createHttp(); h.destroy(); }
    static fileLeak(): void { const h = fs.openSync("x");  }
    static fileRelease(): void { const h = fs.openSync("x"); fs.closeSync(h.fd); }
    static fileioLeak(): void { const h = fileio.openSync("x");  }
    static fileioRelease(): void { const h = fileio.openSync("x"); fileio.closeSync(h); }
    static sourceLeak(): void { const h = image.createImageSource("x");  }
    static sourceRelease(): void { const h = image.createImageSource("x"); h.release(); }
    static pixelLeak(): void { const h = image.createPixelMapSync();  }
    static pixelRelease(): void { const h = image.createPixelMapSync(); h.release(); }
    static packerLeak(): void { const h = image.createImagePacker();  }
    static packerRelease(): void { const h = image.createImagePacker(); h.release(); }
    static async playerLeak(): Promise<void> { const h = await media.createAVPlayer();  }
    static async playerRelease(): Promise<void> { const h = await media.createAVPlayer(); h.release(); }
    static async rendererLeak(): Promise<void> { const h = await audio.createAudioRenderer();  }
    static async rendererRelease(): Promise<void> { const h = await audio.createAudioRenderer(); h.release(); }
    static async capturerLeak(): Promise<void> { const h = await audio.createAudioCapturer();  }
    static async capturerRelease(): Promise<void> { const h = await audio.createAudioCapturer(); h.release(); }
    static resultLeak(store: relationalStore.RdbStore): void { const h = store.querySync();  }
    static resultRelease(store: relationalStore.RdbStore): void { const h = store.querySync(); h.close(); }
    static fileDescriptorAlias(): void { const file = fs.openSync('x'); const fd = file.fd; fs.closeSync(fd); }
    static fileWrongObject(): void { const first = fs.openSync('x'); const second = fs.openSync('y'); fs.closeSync(second.fd); }
    static async fileAwaitRelease(): Promise<void> { const file = await fs.open('x'); fs.closeSync(file.fd); }
    static async pixelAwaitRelease(): Promise<void> { const source = image.createImageSource('x'); const pixel = await source.createPixelMap(); pixel.release(); source.release(); }
    static pendingPlayer(): void { const promise = media.createAVPlayer(); }
    static callbackPlayer(): void { media.createAVPlayer((err, player) => { player.release(); }); }
    static userApi(): void { const h = FakeHttp.createHttp(); }
}
class FakeHttp { static createHttp(): FakeHttp { return new FakeHttp(); } destroy(): void {} }
