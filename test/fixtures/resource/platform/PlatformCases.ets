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
    static fileReleaseFailureCaught(): void {
        const file = fs.openSync('x');
        try { fs.closeSync(file.fd); } catch (error) {}
    }
    static async fileReleaseFailureAwait(): Promise<void> {
        const file = await fs.open('x');
        try { await fs.close(file); } catch (error) {}
    }
    static fileCloseHelper(file: fs.File): void { fs.closeSync(file); }
    static fileCloseMiddle(file: fs.File): void { PlatformCases.fileCloseHelper(file); }
    static fileReleaseFailureFromHelper(): void {
        const file = fs.openSync('x');
        try { PlatformCases.fileCloseHelper(file); } catch (error) {}
    }
    static fileReleaseFailureFromMiddle(): void {
        const file = fs.openSync('x');
        try { PlatformCases.fileCloseMiddle(file); } catch (error) {}
    }
    static fileThrowBeforeCloseHelper(file: fs.File): void {
        throw new Error('before close');
    }
    static fileThrowBeforeCloseMiddle(file: fs.File): void { PlatformCases.fileThrowBeforeCloseHelper(file); }
    static fileFailReplacing(file: fs.File): fs.File { throw new Error('no assignment'); }
    static fileFailedReplacementKeepsHandle(): void {
        let file = fs.openSync('x');
        try { file = PlatformCases.fileFailReplacing(file); } catch (error) {}
        fs.closeSync(file);
    }
    static fileWrapperFailsBeforeClose(): void {
        const file = fs.openSync('x');
        try { PlatformCases.fileThrowBeforeCloseHelper(file); } catch (error) {}
    }
    static fileUnreachableClose(): void {
        const file = fs.openSync('x');
        throw new Error('before close');
        fs.closeSync(file);
    }
    static fileMiddleFailsBeforeClose(): void {
        const file = fs.openSync('x');
        try { PlatformCases.fileThrowBeforeCloseMiddle(file); } catch (error) {}
    }
    static fileReleaseFailureSkipsOther(): void {
        const first = fs.openSync('x');
        const second = fs.openSync('y');
        try { fs.closeSync(first); fs.closeSync(second); } catch (error) {}
    }
    static fileWorkFailsBeforeClose(): void {
        const file = fs.openSync('x');
        try { fs.writeSync(file.fd, 'data'); fs.closeSync(file); } catch (error) {}
    }
    static fileAllocateAndWrite(): void {
        const file = fs.openSync('x');
        fs.writeSync(file.fd, 'data');
        fs.closeSync(file);
    }
    static fileCalleeAllocationFailsBeforeClose(): void {
        try { PlatformCases.fileAllocateAndWrite(); } catch (error) {}
    }
    static fileGuardedDescriptor(): void {
        let fd = -1;
        try { const file = fs.openSync('x'); fd = file.fd; }
        finally { if (fd >= 0) fs.closeSync(fd); }
    }
    static fileGuardedDescriptorReturn(): number {
        let fd = -1;
        try { const file = fs.openSync('x'); fd = file.fd; return 1; }
        finally { if (0 <= fd) fs.closeSync(fd); }
    }
    static fileGuardedDescriptorThrow(): void {
        let fd = -1;
        try { const file = fs.openSync('x'); fd = file.fd; throw new Error('failed'); }
        finally { if (fd > -1) fs.closeSync(fd); }
    }
    static fileInvalidDescriptorReturn(): void {
        const file = fs.openSync('x');
        const fd = file.fd;
        if (fd < 0) return;
        fs.closeSync(fd);
    }
    static fileDescriptorZeroLeak(): void {
        const file = fs.openSync('x');
        const fd = file.fd;
        if (fd > 0) fs.closeSync(fd);
    }
    static fileDescriptorTruthyLeak(): void {
        const file = fs.openSync('x');
        const fd = file.fd;
        if (fd) fs.closeSync(fd);
    }
    static fileDescriptorOverwritten(): void {
        const file = fs.openSync('x');
        let fd = file.fd;
        fd = -1;
        if (fd >= 0) fs.closeSync(fd);
    }
    static fileGuardedOtherObject(): void {
        const first = fs.openSync('x');
        const second = fs.openSync('y');
        if (second) fs.closeSync(second.fd);
    }
    static fileConditionalRelease(flag: boolean): void {
        const file = fs.openSync('x');
        if (flag) fs.closeSync(file.fd);
    }
    static fileGuardedObject(): void {
        let file: fs.File | null = null;
        try { file = fs.openSync('x'); }
        finally { if (file !== null) fs.closeSync(file); }
    }
    static fileGuardedTruthyObject(): void {
        const file = fs.openSync('x');
        if (file) fs.closeSync(file);
    }
    static async fileGuardedAwait(): Promise<void> {
        let file: fs.File | undefined = undefined;
        try { file = await fs.open('x'); }
        finally { if (file !== undefined) await fs.close(file); }
    }
    static sourceGuardedObject(): void {
        const source = image.createImageSource('x');
        if (source !== undefined) source.release();
    }
    static fileioGuardedDescriptor(): void {
        const fd = fileio.openSync('x');
        if (fd !== -1) fileio.closeSync(fd);
    }
    static fileioZeroLeak(): void {
        const fd = fileio.openSync('x');
        if (fd) fileio.closeSync(fd);
    }
    static fileWrongObject(): void { const first = fs.openSync('x'); const second = fs.openSync('y'); fs.closeSync(second.fd); }
    static async fileAwaitRelease(): Promise<void> { const file = await fs.open('x'); fs.closeSync(file.fd); }
    static async pixelAwaitRelease(): Promise<void> { const source = image.createImageSource('x'); const pixel = await source.createPixelMap(); pixel.release(); source.release(); }
    static pendingPlayer(): void { const promise = media.createAVPlayer(); }
    static resultThenRelease(store: relationalStore.RdbStore): void {
        store.query().then((result: relationalStore.ResultSet) => { result.close(); });
    }
    static resultThenLeak(store: relationalStore.RdbStore): void {
        store.query().then((result: relationalStore.ResultSet) => {});
    }
    static resultThenWrongObject(store: relationalStore.RdbStore): void {
        const other = store.querySync();
        store.query().then((result: relationalStore.ResultSet) => { other.close(); });
    }
    static resultCatchWrongObject(store: relationalStore.RdbStore): void {
        store.query().catch((error: relationalStore.ResultSet) => { error.close(); });
    }
    static fileCallbackRelease(): void {
        const file: fs.File = fs.openSync('x');
        Promise.resolve().then(() => { fs.writeSync(file.fd, 'data'); fs.closeSync(file.fd); });
    }
    static fileCallbackWrongObject(): void {
        const first: fs.File = fs.openSync('x');
        const second: fs.File = fs.openSync('y');
        Promise.resolve().then(() => { fs.closeSync(second.fd); });
    }
    static callbackPlayer(): void { media.createAVPlayer((err, player) => { player.release(); }); }
    static userApi(): void { const h = FakeHttp.createHttp(); }
}
class FakeHttp { static createHttp(): FakeHttp { return new FakeHttp(); } destroy(): void {} }
