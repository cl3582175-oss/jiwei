// pdf.js 的解析器模块没有类型声明；只用于放进 globalThis.pdfjsWorker
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
