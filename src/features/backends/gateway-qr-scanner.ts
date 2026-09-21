import QrScanner from "qr-scanner";
import workerPath from "qr-scanner/qr-scanner-worker.min.js?url";

// 扫码跑在 Web Worker 里。打包后 worker 不会自己出现在 dist 下，
// 必须显式 ?url 引进来让 Vite 把它当资源拷走；否则扫码永远不触发，
// 而报错只在控制台里，用户看到的就是「点了没反应」。
QrScanner.WORKER_PATH = workerPath;
export async function startGatewayQrScanner(
  video: HTMLVideoElement,
  onResult: (value: string) => void,
) {
  const scanner = new QrScanner(
    video,
    (result) => onResult(result.data),
    {
      preferredCamera: "environment",
      highlightScanRegion: true,
      highlightCodeOutline: true,
      returnDetailedScanResult: true,
    },
  );
  try {
    await scanner.start();
  } catch (error) {
    scanner.destroy();
    throw error;
  }
  return () => scanner.destroy();
}

export async function scanGatewayQrImage(file: File) {
  const result = await QrScanner.scanImage(file, {
    returnDetailedScanResult: true,
    alsoTryWithoutScanRegion: true,
  });
  return result.data;
}
